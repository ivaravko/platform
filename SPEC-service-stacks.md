# Spec: service-stacks

Module `service-stacks` of the [Platform capability map](SPEC.md#capability-map).
**Build fourth — after `environment-provisioning`, before `release-path`.**
Shared toolchain, code style, and boundaries are inherited from [SPEC.md](SPEC.md).

## Objective

Make the generated `infra/` **environment-aware**: one program, two stacks — `staging` and
`production` — deploying into the two separate GCP projects
[`environment-provisioning`](SPEC-environment-provisioning.md) prepared.

**Users**
- *Service developers* — run `pulumi preview`/`up` against `staging` from a laptop and never think
  about `production`, because they cannot reach it.
- *Platform engineers* — need the two stacks to differ in **configuration only**, so that what
  staging proves, production inherits.

**Success looks like:** the same compiled program, selected by stack, produces a private Cloud Run
service in `demo-staging` or `demo-production` with no edit to a single line of TypeScript.

### What already exists

The D-series branch (`d6-generated-preview`) built most of the program: the scaffold emits
`infra/Pulumi.yaml`, `infra/index.ts` composing `SecureArtifactRepository` + `SecureServiceAccount` +
`SecureContainerService`, and `infra/tsconfig.json`. It reads `gcp:project`, `gcp:region` and
`imageTag` from config already.

**This module is the delta, not a rewrite:** per-stack configuration, digest promotion, and the two
corrections below.

## One program, two stacks

```
infra/
├─ Pulumi.yaml                 → name, runtime, and `typescript: false`
├─ Pulumi.staging.yaml         → gcp:project = <service>-staging
├─ Pulumi.production.yaml      → gcp:project = <service>-production
├─ index.ts                    → identical for both; branches on nothing
└─ tsconfig.json
```

**The program must not branch on environment.** No `if (stack === "production")`. Every difference
between the two environments is a config value, because a conditional is a place where production
can quietly diverge from what staging tested — and the entire argument for having a staging
environment is that it tested the thing you are about to ship.

If a difference cannot be expressed as configuration, that is a signal the two environments are
diverging in a way worth arguing about, not a reason to add a branch.

| Key | staging | production |
|-----|---------|------------|
| `gcp:project` | the staging project | the production project |
| `gcp:region` | required, no default | required, no default |
| `image` | a tag or a digest | **a digest, always** |

## Project ids are derived, not passed

```
runway new demo   →   gcp:project = demo-staging     (Pulumi.staging.yaml)
                      gcp:project = demo-production  (Pulumi.production.yaml)
```

`<service>-staging` and `<service>-production`. No flags, no config file, no identifier copied
between two commands — the scaffold already knows the name, so it can write both stack configs
itself. `environment-provisioning` adopts projects under the same rule, which is what makes the seam
between the two modules disappear rather than need specifying.

**The convention is load-bearing, so `runway new` must enforce what it implies.** A GCP project id
is globally unique, 6–30 characters, and must start with a letter. Two of those now constrain the
service name, and neither is enforced today — `SERVICE_NAME` currently allows a leading digit and up
to 214 characters:

| Rule | Why | Today |
|------|-----|-------|
| Name ≤ **19** characters | `-production` is 11, and the id cap is 30 | 214 |
| Name starts with a **letter** | A project id may not start with a digit, so `2fa` yields the invalid `2fa-staging` | `^[a-z0-9]` |

Both are validation changes in `runway new`, and both should fail at the point the name is typed —
long before anyone discovers the problem as a GCP API error during bootstrap.

**Global uniqueness is the residual risk, and it is accepted rather than solved.** `demo-staging` is
a plausible id in a namespace shared with every GCP customer, so a team will eventually pick a name
whose project belongs to someone else. Adoption must therefore distinguish *"the project does not
exist"* from *"the project exists and you cannot see it"* — the second is what a collision looks
like, and reporting it as "not found" would send someone hunting for the wrong problem.

## Promotion is a digest, not a rebuild

Production deploys the exact artifact staging ran. `image` in `Pulumi.production.yaml` is a
`sha256:` digest, never a mutable tag: a tag can be repointed, and then production is running
something no environment tested.

| Control | |
|---------|--|
| SS-01 | The program never branches on stack name; environment differences are config only |
| SS-02 | `Pulumi.production.yaml` carries a digest-pinned image; a tag reference fails the build |
| SS-03 | Neither stack is publicly reachable without a justified `publicAccess` opt-out |
| SS-04 | Every stack declares `typescript: false` and runs precompiled JavaScript |
| SS-05 | No project id, region, or credential appears as a literal in generated TypeScript |
| SS-06 | Stack config carries `<service>-staging` / `<service>-production`, and `runway new` rejects a name that cannot produce a valid project id |

## One correction this module owes

**SS-04 was already fixed.** An earlier draft of this spec listed the generated `Pulumi.yaml` as
missing `runtime.options.typescript: false`. D6 had already added it, along with
`main: lib/index.js` and a `compile:infra` task. Recorded here because the claim appeared in this
spec and was wrong, not because anything remains to do.

**SS-05 — a region default is baked into generated source.**
[SPEC-runway-cli.md](SPEC-runway-cli.md#boundaries) says never to bake region defaults into
generated source; they come from Pulumi config. The generated program currently reads:

```ts
const location = gcpConfig.get("region") ?? "europe-west1";
```

A default is worse than a missing value here: an unset region silently deploys to Belgium instead of
failing. `require("region")` turns a silent wrong answer into a loud missing one. The same applies
to `imageTag`'s `?? "v1"`.

## Commands

```bash
# From the generated repo
pulumi stack select staging
pulumi preview                       # staging: a developer can run this
pulumi up

pulumi stack select production
pulumi preview                       # succeeds: preview is read-only
pulumi up                            # 403 from Google unless running as CI
```

Developing the module:
```bash
npm run build --workspace @runway/cli
npm test --workspace @runway/cli -- -t "service stacks"
```

## Testing Strategy

| Level       | What it does                                                                    | Gate |
|-------------|----------------------------------------------------------------------------------|------|
| Generation  | Scaffold emits both stack config files with the expected keys                     | Blocking |
| Static      | `index.ts` contains no stack-name conditional and no project/region literal (SS-01, SS-05) | Blocking |
| Digest      | A tag reference in `Pulumi.production.yaml` fails the build (SS-02)               | Blocking |
| Build-out   | The generated repo compiles `infra/` and `pulumi preview --stack staging` plans three resource groups | Blocking |
| Integration | `pulumi preview` against the sandbox project, both stacks                         | Blocking before release |

The build-out test is the one that matters. Asserting the *files* exist proves we can write YAML;
running `pulumi preview` proves the program compiles, resolves config, and plans what it should.

## Boundaries

Inherits [SPEC.md](SPEC.md#boundaries) and [SPEC-runway-cli.md](SPEC-runway-cli.md#boundaries).
Module-specific:

**Always**
- Express environment differences as configuration.
- Pin production to a digest.
- Declare `typescript: false` in every generated `Pulumi.yaml`.

**Ask first**
- Adding a third stack, or a per-developer stack. Both are reasonable and both change
  [`release-path`](SPEC.md#capability-map)'s enforcement surface.
- Any config key that exists in one environment and not the other.

**Never**
- Branch the program on stack name.
- Default a project id, region, or image reference in generated source. Fail loudly instead.
- Put a secret in a stack config file. `pulumi config set --secret` exists; a plaintext value in a
  committed YAML does not stop being a secret because it is inconvenient.

## Success Criteria

1. `runway new demo` emits `Pulumi.yaml`, `Pulumi.staging.yaml`, `Pulumi.production.yaml`.
2. `pulumi preview --stack staging` in the generated repo plans exactly three resource groups —
   service account, artifact repository, Cloud Run service — with nothing publicly reachable.
3. The same is true of `--stack production`, against the other project, with no source change.
4. `grep -E "if.*stack|europe-west|projects/" infra/index.ts` returns nothing (SS-01, SS-05).
5. `Pulumi.yaml` declares `typescript: false`, and `pulumi preview` runs without ts-node (SS-04).
6. A `Pulumi.production.yaml` whose `image` is a tag rather than a digest fails the build (SS-02).
7. An unset `gcp:region` fails with a message naming the key, rather than defaulting.
8. `runway new` rejects a name longer than 19 characters, and one beginning with a digit, each with
   a message explaining the GCP project-id rule behind it (SS-06).
9. Adoption reports an existing-but-inaccessible project as a name collision, not as "not found".

## Open Questions

1. ~~Where do the two stack config files get their project ids?~~ **Resolved: derived from the
   service name.** See [Project ids are derived, not passed](#project-ids-are-derived-not-passed).
2. **Does `runway new` create the Pulumi stacks, or only the files?** `pulumi stack init staging`
   needs the state backend to exist and be reachable, which drags provisioning into scaffold time.
   Emitting files and letting the first `pulumi up` initialise is the lower-coupling answer.
3. **Is `staging` allowed to be public?** SS-03 says no environment is public without a justified
   opt-out. A team wanting a publicly reachable staging URL is a plausible, reasonable request, and
   the opt-out already exists — worth confirming that it applies per stack rather than per service.
