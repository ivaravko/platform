# Spec: release-path

Module `release-path` of the [Platform capability map](SPEC.md#capability-map).
**Build fifth — last of the two-environment modules.**
Shared toolchain, code style, and boundaries are inherited from [SPEC.md](SPEC.md).

## Objective

Two routes to a running service, and one of them a developer cannot take.

Staging is deployed from a laptop, by hand, as often as anyone likes. Production is deployed only by
CI, only from a tag, and only as the digest staging already ran.

**Users**
- *Service developers* — deploy to staging constantly and never think about production, because the
  attempt would fail at Google's door rather than at a policy they could argue with.
- *Platform engineers* — need "what shipped" to be answerable from the tag list, and "who deployed
  it" to be answerable at all.

**Success looks like:** `git tag v1.4.0 && git push --tags` puts the exact artifact staging verified
into production, and nothing else in the repository can.

### Why this is one module and not two

It spans a laptop and a CI runner, which looks like two things. Permission and refusal are one rule
seen from both sides: production is deployable *precisely* by the identity localhost does not have.
Splitting it would put half a contract in each spec.

## The prerequisite: nothing builds the image

This module promotes an artifact. **No artifact exists.** The scaffold emits no `Dockerfile`, and no
workflow builds or pushes a container — the Dockerfile was cut from the runway-cli prototype and
never returned. `SecureArtifactRepository` creates the registry; nothing puts anything in it.

So `release-path` cannot be built end to end until something publishes an image. That work is not
specified anywhere, and it belongs in `runway-cli`'s scaffold output rather than here — adding a
file to the scaffold is [ask-first](SPEC-runway-cli.md#boundaries).

Recorded now rather than discovered at implementation: **this module is blocked, and the blocker is
one file and one workflow job in a different module.**

## The two routes

```
localhost                                  CI, on a pushed tag
  gcloud auth application-default login      Workload Identity Federation
  pulumi up --stack staging                  resolve tag → digest
        ↓                                    pulumi config set imageDigest
  demo-staging                               pulumi up --stack production
  developer's own identity                          ↓
                                             demo-production
                                             a federated identity, scoped to
                                             this repository and this ref
```

**No `runway deploy`.** Staging is plain `pulumi up`, documented in the generated README. A wrapper
would put `runway` on the critical path of every deploy rather than only scaffolding, and a wrapper
that refuses production would be a guardrail that only guards the obedient — `pulumi` is right there.
The boundary is IAM, and IAM does not care which tool asks.

## Promotion resolves a tag to a digest

The tag is the release name; the digest is what deploys.

1. `v1.4.0` is pushed.
2. CI resolves `<registry>/<service>:v1.4.0` to its digest, from Artifact Registry.
3. That digest is set as `imageDigest` on the production stack.
4. `pulumi up --stack production`.

Step 2 is the whole point. Production never re-resolves a tag at deploy time, because a tag can move
between the resolution and the rollout — and `SecureArtifactRepository` making tags immutable
protects the registry, not a consumer who re-reads one later.

| Id | Control |
|----|---------|
| RP-01 | Production deploys run only from CI, authenticated by Workload Identity Federation; no service account key exists anywhere in the path |
| RP-02 | Production deploys a digest, never a tag — the resolution happens once, in CI, and is recorded in the run log |
| RP-03 | A tag that does not resolve to an image in the registry fails the release before any deploy is attempted |
| RP-04 | Staging deploys use the developer's own credentials, so the audit log names a person |
| RP-05 | No workflow file contains a literal credential; the only secret referenced is the one federation needs |
| RP-06 | Rollback is `release.yml` dispatched on an existing tag's ref — same identity, same resolution, the dispatching actor recorded in the run log; a dispatch on a non-tag ref fails before any deploy step |

**RP-03 is the one that will be skipped.** Resolving a missing tag returns an error that is easy to
swallow and continue past, and the failure then arrives as a Cloud Run revision that cannot pull its
image — long after the release looked successful.

## Rollback is the same release, dispatched

Production rolls back through an explicit path, and the path is not a new mechanism. `release.yml`
carries a second trigger, `workflow_dispatch`, and rolling back is dispatching it on the tag to
return to:

```bash
gh workflow run release.yml --ref v1.3.0
```

The run is a release run in every way that matters: the same federated identity, the same
resolution of tag to digest, the same RP-03 refusal if the tag no longer resolves. It performs its
own resolution and records it (RP-02) — it does not trust the original release's run log, which may
have expired. What changes is what the run log answers: a dispatch names the person who asked for
it, so "who rolled back" is an actor, not an inference from a tag push.

Dispatching **on the tag's own ref** is the load-bearing choice:

- The WIF attribute condition already trusts tag refs; nothing widens to accommodate rollback. A
  dispatch on a branch ref is refused twice — by a guard in the workflow before any deploy step,
  and by Google when federation rejects the ref.
- The workflow that runs is the workflow as of that tag, so an old release rolls back with the
  deploy configuration it shipped with, not today's. (A dispatch needs `release.yml` to exist at
  the tag; in a scaffolded repository it exists from the first commit.)

The alternatives, and why not:

- **Re-tagging an older commit** conflates roll back with release again. The tag list is how "what
  shipped" is answered, and it stops being a truthful history the moment `v1.4.1` is secretly
  `v1.3.0`.
- **A separate `rollback.yml`** fails the same test that split `release.yml` from `build.yml`:
  trigger, permissions, failure meaning. Only the trigger differs — the permissions are identical,
  and a red run means the same thing, production did not change. A second file would duplicate the
  deploy job to express one extra trigger line.

## Commands

```bash
# Staging, from a laptop
gcloud auth application-default login
cd infra && pulumi stack select staging && pulumi up

# Production
git tag v1.4.0 && git push origin v1.4.0     # the entire release interface

# Rollback
gh workflow run release.yml --ref v1.3.0     # re-run the release that tag was
```

There is deliberately no local command that deploys production. Attempting it is not blocked by
tooling — it fails at Google:

```
$ pulumi up --stack production
error: 403 PERMISSION_DENIED
```

## Project Structure

Generated into the service repository:

```
.github/workflows/
├─ build.yml        → existing: build, test, lint on every PR
└─ release.yml      → new: on a pushed tag, resolve and deploy to production
```

`release.yml` is a second workflow rather than a job in `build.yml`, because its trigger, its
permissions and its failure meaning are all different. A red build means the code is wrong; a red
release means production did not change.

## Testing Strategy

| Level | What it does | Gate |
|-------|--------------|------|
| Generation | The scaffold emits `release.yml`; its trigger is a tag, and it references exactly one secret | Blocking |
| Static | No credential literal in any workflow; the WIF binding names repository and ref | Blocking |
| Resolution | A tag absent from the registry fails before any deploy step runs (RP-03) | Blocking |
| Rollback | `release.yml`'s triggers are exactly tag-push and dispatch, and its first step refuses a non-tag ref (RP-06) | Blocking |
| Integration | A real tag push against the sandbox resolves and previews production | Before release |

**The staging refusal cannot be unit-tested.** That a developer's `pulumi up --stack production`
returns 403 is a property of GCP IAM, established by
[`environment-provisioning`](SPEC-environment-provisioning.md)'s integration test, and asserted
there. Re-asserting it here with a mock would be a test of our mock.

## Boundaries

Inherits [SPEC.md](SPEC.md#boundaries). Module-specific:

**Always**
- Resolve the tag to a digest in CI, once, and deploy that digest.
- Fail the release if the tag does not resolve.
- Keep the production path free of any long-lived credential.

**Ask first**
- Adding a `runway deploy` command. It was considered and declined; reversing that is a decision.
- Deploying production on anything other than a tag.
- Any approval gate — the current design is IAM-only, with no human in the release loop.

**Never**
- Deploy production from a developer's machine, or add a path that would allow it.
- Deploy a tag to production. Tags name releases; digests are what run.
- Create a service account key for the release path.
- Run `pulumi up --stack production` in a test.

## Success Criteria

1. `runway new` emits `release.yml`, triggered on tags matching `v*`, referencing exactly one secret.
2. Pushing `v1.4.0` deploys production with the digest that tag resolves to, and the run log records
   the resolution.
3. A tag absent from the registry fails the run before any `pulumi` step (RP-03).
4. `gcloud iam service-accounts keys list` returns no user-managed keys in the production project.
5. A developer running `pulumi up --stack production` receives 403 — observed, not asserted.
6. `grep -rE "AIza|-----BEGIN|ghp_" .github/` in a generated repo returns nothing.
7. `gh workflow run release.yml --ref v1.3.0` redeploys the digest `v1.3.0` resolves to, with the
   dispatching actor in the run log; the same dispatch on `main` deploys nothing.

## Open Questions

1. **What publishes the image?** Still open, and still the blocker. A `Dockerfile` plus a
   build-and-push job in `build.yml`, both additions to `runway-cli`'s scaffold output and therefore
   ask-first. The Dockerfile now has two build steps to run — `vite build` for the client and `tsc`
   for the server — since the generated service became a SPA.

   **The ordering half of this question is resolved:** a new environment's first apply is two-phase,
   registry first, then push, then the rest. See
   [service-stacks](SPEC-service-stacks.md#the-first-deploy-of-an-environment-is-two-phases).
2. ~~Does production roll back, and how?~~ **Resolved: an explicit path.** `release.yml` gains a
   `workflow_dispatch` trigger, dispatched on the ref of the tag to return to. See
   [Rollback is the same release, dispatched](#rollback-is-the-same-release-dispatched).
3. **What resolves the tag — `gcloud` or the Pulumi provider?** `gcloud artifacts docker images
   describe` is direct and adds a CLI dependency to the workflow; reading it through the provider
   keeps the toolchain narrower and is more indirection than the job needs.
4. **Does a failed production deploy notify anyone?** A red workflow is visible to whoever looks. If
   releases are expected to be unattended, silence on failure is the wrong default — but alerting is
   not specified anywhere in this initiative yet.
