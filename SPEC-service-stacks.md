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
| `imageTag` | `v1` to start from | **absent** |
| `imageDigest` | absent | **written by CI at promotion** |

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

| Rule | Why | Status |
|------|-----|--------|
| Name ≤ **19** characters | `-production` is 11, and the id cap is 30 | **enforced** |
| Name starts with a **letter** | A project id may not start with a digit, so `2fa` yields the invalid `2fa-staging` | **enforced** |

Both fail at the point the name is typed, and both messages name the project-id rule behind the
refusal rather than reporting a bare "invalid name" that would leave someone shortening by guesswork.

**Global uniqueness is the residual risk, and it is accepted rather than solved.** `demo-staging` is
a plausible id in a namespace shared with every GCP customer, so a team will eventually pick a name
whose project belongs to someone else. Adoption must therefore distinguish *"the project does not
exist"* from *"the project exists and you cannot see it"* — the second is what a collision looks
like, and reporting it as "not found" would send someone hunting for the wrong problem.

## The first deploy of an environment is two phases

The stack creates the registry and the Cloud Run service in one program, so a brand-new environment
has an ordering problem: `pulumi up` creates the registry, then asks Cloud Run to pull an image that
nothing has pushed — and nothing could have pushed it, because the registry did not exist until a
moment ago.

The resolution is an explicit two-phase first apply:

```bash
pulumi up --target '**SecureArtifactRepository**'   # registry only; its own deps come implicitly
# build and push the image
pulumi up                                                              # everything else
```

**No `--target-dependents`** — corrected 2026-08-26 by the first real two-phase apply: the Cloud
Run service *depends on* the registry, so "dependents" drags the whole stack into phase one and
errors on everything not targeted. A target's own dependencies are included implicitly, which is
all phase one needs.

**Only the first apply per environment.** Every subsequent deploy is a single `pulumi up`, because
the registry already exists.

**This carries the risk that killed the state-migration option in
[`environment-provisioning`](SPEC-environment-provisioning.md#the-bootstrap-paradox-and-its-answer),
and it is worth naming rather than hoping.** A step that runs once per environment is the
least-exercised path there is, and it will be reached for on the day someone is setting up
production under time pressure. Two things follow:

- It must be a **task in the generated repo**, not a sequence someone retypes from a README.
  `npm run deploy:bootstrap` can be wrong once and fixed; a documented ritual is wrong every time
  somebody skips a line.
- The integration tier should exercise it at least once, so "the first deploy works" is a claim with
  evidence behind it rather than a paragraph.

The alternative designs were considered and declined: moving the registry into
`environment-provisioning` would remove the ordering problem entirely but relocate a component
across modules, and a placeholder public image would ship a scaffold whose default container is not
the team's own.

## Promotion is a digest, not a rebuild

Production deploys the exact artifact staging ran, referenced by digest — a tag can be repointed,
and then production is running something no environment tested.

**A generated `Pulumi.production.yaml` carries no image at all.** There is no digest at scaffold
time, because the image does not exist yet, and a tag there would be worse than nothing: it would
satisfy the config and leave production tracking something mutable. CI writes `imageDigest` at
promotion. Until then production cannot preview, which is the honest state of an environment nothing
has been promoted to.

The program prefers `imageDigest` over `imageTag` when both are set. That is a branch on
configuration, not on stack name — production runs a digest because CI configured one, not because
the program knows which stack it is (SS-01). With neither set it throws, naming both keys.

| Control | |
|---------|--|
| SS-01 | The program never branches on stack name; environment differences are config only |
| SS-02 | `Pulumi.production.yaml` carries a digest-pinned image; a tag reference fails the build |
| SS-03 | Neither stack is publicly reachable without a justified `publicAccess` opt-out |
| SS-04 | Every stack declares `typescript: false` and runs precompiled JavaScript |
| SS-05 | No project id, region, or credential appears as a literal in generated TypeScript |
| SS-06 | Stack config carries `<service>-staging` / `<service>-production`, and `runway new` rejects a name that cannot produce a valid project id |

## Corrections

**SS-04 was already fixed.** An earlier draft of this spec listed the generated `Pulumi.yaml` as
missing `runtime.options.typescript: false`. D6 had already added it, along with
`main: lib/index.js` and a `compile:infra` task. Recorded here because the claim appeared in this
spec and was wrong, not because anything remains to do.

**SS-05 is fixed.** The generated program read
`gcpConfig.get("region") ?? "europe-west1"`, which
[SPEC-runway-cli.md](SPEC-runway-cli.md#boundaries) forbids — and the default was the worse failure,
since an unset region deployed somewhere nobody chose rather than stopping. It now reads
`gcpConfig.require("region")`.

This cost no working configuration: `gcp:project` was already required, so a fresh scaffold could
never preview without config anyway. The default was protecting nothing.

**The `?? "v1"` fallback this section once defended no longer exists.** The program now reads
`config.get("imageTag")` with no default and throws when neither `imageDigest` nor `imageTag` is
set, naming both keys — the stricter behaviour the earlier note said was worth revisiting. The
revisit happened alongside SS-02's enforcement (P1 of the v1 close-out plan): production carries a
digest or nothing, and the generated repo's own suite fails on a tag. Recorded because the earlier
claim appeared here and drifted from the code, not because anything remains to do.

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
| Integration | `pulumi preview` against the sandbox project, both stacks — `test-integration/preview/generated-repo.test.ts` | Blocking before release |

The build-out test is the one that matters. Asserting the *files* exist proves we can write YAML;
running `pulumi preview` proves the program compiles, resolves config, and plans what it should.

Every SS id is named in a passing test (`npm test --workspace @runway/cli -- -t "SS-"`). SS ids
get **no rows** in [docs/control-mapping.md](docs/control-mapping.md) — decided 2026-08-26; the
reason lives there, beside the rule it protects.

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
2. ~~Does `runway new` create the Pulumi stacks, or only the files?~~ **Resolved: only the files.**
   `pulumi stack init` needs a reachable state backend, which would let `runway new` fail for
   reasons unrelated to scaffolding. The first `pulumi up` initialises.
3. ~~Is `staging` allowed to be public?~~ **Resolved 2026-08-26: yes, config-keyed.** The justified
   `publicAccess` opt-out may be exercised per stack — and *must* be keyed on configuration,
   because one program serves both stacks, so an opt-out written directly into `infra/index.ts`
   opens production with it. The working pattern, in the team's own edit:

   ```ts
   const publicJustification = config.get("publicJustification");

   new SecureContainerService("web", {
     // ...
     publicAccess:
       publicJustification === undefined
         ? undefined
         : { justification: publicJustification },
   });
   ```

   with the key in `Pulumi.staging.yaml` **only**:

   ```yaml
   demo:publicJustification: "stakeholder preview before launch"
   ```

   Production stays private because its config never carries the key — the same
   branch-on-config-never-on-stack-name mechanism as `imageDigest`/`imageTag`, so SS-01 is
   preserved. The pairwise proof that the opt-out applied on one construction leaves the other
   private is CR-03's existing test pair (`emits exactly one allUsers invoker binding when
   public` / `emits no invoker binding at all on the private path`) — referenced rather than
   duplicated, per the rule that a weaker copy beside a stronger test gets cited as coverage.
   **The scaffold's default output is unchanged**: nothing public, no new file, no new config key
   emitted.
