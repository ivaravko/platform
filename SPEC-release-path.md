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

**Since closed.** The scaffold now emits both — approved as ask-first, verified end to end against
the published registry. See [open question 1](#open-questions) for what was built. This module is no
longer blocked.

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
2. CI resolves **the tagged commit's image** — `<staging registry>/<service>:sha-<commit>`, pushed
   by `build.yml` when that commit landed on `main` — to its digest.
3. The production registry is ensured first — a targeted apply of `SecureArtifactRepository`, the
   two-phase first apply [service-stacks](SPEC-service-stacks.md#the-first-deploy-of-an-environment-is-two-phases)
   requires, encoded in the workflow because production's only deployer *is* the workflow. A no-op
   from the second release on.
4. The digest is copied into the production registry, named `v1.4.0` there, and its presence is
   verified by digest before anything deploys. Each environment pulls from its own registry, so the
   artifact must exist in production's — promotion is literally the artifact moving.
5. `imageDigest` is set on the production stack, and `pulumi up` deploys everything else.

Step 2 resolves the commit's image rather than a registry tag named `v1.4.0`, because no such
registry tag exists before the release — the only way it could is a rebuild at release time, and
promotion is an artifact moving, not a rebuild. The git tag names the commit; the commit names the
image staging already ran. Production never re-resolves anything at deploy time, because a tag can
move between the resolution and the rollout — and `SecureArtifactRepository` making tags immutable
protects the registry, not a consumer who re-reads one later.

| Id | Control |
|----|---------|
| RP-01 | Production deploys run only from CI, authenticated by Workload Identity Federation; no service account key exists anywhere in the path |
| RP-02 | Production deploys a digest, never a tag — the resolution happens once, in CI, and is recorded in the run log |
| RP-03 | A tag that does not resolve to an image in the registry fails the release before any deploy is attempted |
| RP-04 | Staging deploys use the developer's own credentials, so the audit log names a person |
| RP-05 | No workflow file contains a literal credential, and the release path references no stored secret at all — federation mints an identity token per run |
| RP-06 | Rollback is `release.yml` dispatched on an existing tag's ref — same identity, same resolution, the dispatching actor recorded in the run log; a dispatch on a non-tag ref fails before any deploy step |

**RP-03 is the one that will be skipped.** Resolving a missing tag returns an error that is easy to
swallow and continue past, and the failure then arrives as a Cloud Run revision that cannot pull its
image — long after the release looked successful.

**Its failure mode is proven against a real registry** (2026-08-26,
`test-integration/deploy/release-resolution.test.ts`): the exact resolve command run against a tag
nothing pushed exits non-zero *and* yields no digest — either half alone stops `release.yml` before
a deploy step. The positive half, a present tag resolving, waits for the first real release: nothing
can push an image until a generated repo's CI has federation.

**RP-04 is observed** (2026-08-26): the `first01` staging service's audit trail names the person
who deployed it, from their own credentials — read back from Google, not asserted. The release legs
— a tag push federating into production, RP-01/RP-02/RP-06 at runtime, and the 403 — were skipped
with production by the user's decision; the sha-tagged artifact the first release will resolve is
already in the staging registry, waiting.

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
| Generation | The scaffold emits `release.yml`; its trigger is a tag, and it references no stored secret | Blocking |
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
- Any failure alerting. Considered and declined: a red run is the signal, and the tag pusher watches
  it. Reversing that is a decision.

**Never**
- Deploy production from a developer's machine, or add a path that would allow it.
- Deploy a tag to production. Tags name releases; digests are what run.
- Create a service account key for the release path.
- Run `pulumi up --stack production` in a test.

## Success Criteria

1. `runway new` emits `release.yml`, triggered on tags matching `v*`, referencing no stored secret
   — the spec anticipated one for federation; federation as implemented needs none.
2. Pushing `v1.4.0` deploys production with the digest that tag resolves to, and the run log records
   the resolution.
3. A tag absent from the registry fails the run before any `pulumi` step (RP-03).
4. `gcloud iam service-accounts keys list` returns no user-managed keys in the production project.
5. A developer running `pulumi up --stack production` receives 403 — observed, not asserted.
6. `grep -rE "AIza|-----BEGIN|ghp_" .github/` in a generated repo returns nothing.
7. `gh workflow run release.yml --ref v1.3.0` redeploys the digest `v1.3.0` resolves to, with the
   dispatching actor in the run log; the same dispatch on `main` deploys nothing.

## Open Questions

1. ~~What publishes the image?~~ **Resolved: the scaffold does.** A two-stage `Dockerfile` — both
   build steps in the builder, no `node_modules` in the ship stage — and a `package` job in
   `build.yml` that pushes `sha-<commit>` images on `main`, authenticated by federation. The job is
   inert until `runway bootstrap` exists and sets the two repository variables it names —
   `RUNWAY_WIF_PROVIDER` and `RUNWAY_CI_SERVICE_ACCOUNT` — which is now a contract bootstrap must
   honour.

   The ordering half was resolved earlier: a new environment's first apply is two-phase, registry
   first, then push, then the rest. See
   [service-stacks](SPEC-service-stacks.md#the-first-deploy-of-an-environment-is-two-phases).
2. ~~Does production roll back, and how?~~ **Resolved: an explicit path.** `release.yml` gains a
   `workflow_dispatch` trigger, dispatched on the ref of the tag to return to. See
   [Rollback is the same release, dispatched](#rollback-is-the-same-release-dispatched).
3. ~~What resolves the tag — `gcloud` or the Pulumi provider?~~ **Resolved: `gcloud`.** The runner
   ships it, federation authenticates it without another moving part, and its failure mode — a
   non-zero exit on a missing image — is exactly the gate RP-03 needs, before any deploy step.
4. ~~Does a failed production deploy notify anyone?~~ **Resolved: no.** A red run is the failure
   signal, and nothing else is built. The consequence is accepted rather than hidden: releases are
   attended by convention — whoever pushes the tag owns watching the run, and the same for a
   rollback dispatch. If unattended releases ever become the expectation, this is the decision to
   revisit first.
