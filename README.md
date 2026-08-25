# platform

A paved road onto GCP: `runway new` produces a repository that builds, tests, lints, and deploys a
security-hardened Cloud Run service, so a team's first commit is already correct.

A service team should not have to be a GCP security expert to ship safely, and hardening should
propagate by version bump rather than by chasing teams. So the guardrails are components, not
documentation — defaults you have to work to opt out of, with the justification recorded on the
resource when you do.

**This README describes what is built and verified today.** Everything in the first three sections
was run against this repository and a real GCP project while writing it; the last section says what
is not built yet.

## Quick start

```bash
npm install        # must precede projen: .projenrc.ts imports it
npm run build      # compile → test → lint, every package
```

`build` is the whole pull-request gate: credential-free, offline, 291 tests.

## What works today

### Scaffolding a service

```bash
runway new <service-name>
```

Emits 20 files — `src/`, `test/`, `infra/`, a CI workflow, and a `.projenrc.ts` that is the only
file meant to be hand-edited. Verified end to end:

```
runway new demo-svc            → 20 files
npm install && npm run build   → exit 0, 1 test passing
pulumi preview  (real GCP)     → exit 0, 7 resources planned
  with the policy pack         → ✅ runway-gcp@v0.0.1, no violations
```

`infra/index.ts` is the load-bearing artifact: it composes all three components and is deployable
unmodified.

```
imageRepository  europe-west1-docker.pkg.dev/<project>/demo-svc
runtimeIdentity  demo-svc@<project>.iam.gserviceaccount.com
serviceName      demo-svc-f0956c4
```

The CLI surface is exactly two things — `runway new <name>` and `runway --help`. There are no flags.

### The components

Sixteen controls, catalogued in [docs/control-mapping.md](docs/control-mapping.md) with the Google
guidance each rests on, the tests that prove it, and the CrossGuard rule that catches consumers who
bypass the component entirely.

| Component | Guarantees |
|---|---|
| `SecureContainerService` | Private ingress by default; no public invoker binding without a written justification recorded on the resource; a user-managed runtime identity; deletion protection on |
| `SecureServiceAccount` | User-managed keys impossible to create through the library; no roles granted unless named; project-wide and `*admin` roles rejected |
| `SecureArtifactRepository` | Immutable Docker tags with no opt-out; vulnerability scanning never disabled; retention that actually deletes |

**That document is checked by a test, in both directions.** A control without a row fails, and a row
without a test fails. A mapping that has drifted from its suite is worse than none, because it reads
as proof.

### Testing

| Tier | Proves | Runs |
|---|---|---|
| Unit | The plan has the right shape (`pulumi.runtime.setMocks`) | every PR, blocking |
| Policy | The CrossGuard pack catches bypasses | every PR, blocking |
| Generation | The scaffold emits a repo that builds | every PR, blocking |
| Integration | GCP accepts and enforces what we planned | on demand — see below |

**No test in the pull-request gate may touch GCP or need credentials.** Fork contributors cannot
hold credentials, and a gate that needs them makes every external contribution red.

The integration tier runs against a real sandbox project:

```bash
export GOOGLE_CLOUD_PROJECT=enduring-badge-506610-u9   # the only project it will run against
gcloud auth application-default login

npm run test:integration            # preview (9) → deploy (12) → leak check (2)
npm run test:integration:preview    # plans against real GCP, creates nothing
npm run test:integration:deploy     # deploys, asserts, destroys
```

It exists for what mocks cannot see: whether the provider still accepts our resource shapes, whether
a policy rule resolves through the engine's real dependency graph, and whether GCP reports back what
Pulumi thinks it asked for. **It reads deployed state through the GCP API, never through Pulumi
state** — state records what we asked for, the API reports what GCP did, and CR-06 is the standing
proof that these differ. A guard refuses any project but the sandbox, and is tested in the PR gate
rather than only in the tier it protects.

**Not an emulator, deliberately.** LocalStack has no GCP support, and the third-party GCP emulators
do not implement IAM enforcement, Artifact Registry, or Binary Authorization — most of what this
repo hardens. An emulator returns `200 OK` for a wide-open `allUsers` binding as readily as for a
locked-down one, so the suite could not fail on a security regression. See
[SPEC-integration-tests.md](SPEC-integration-tests.md).

## Working in this repository

```bash
npm run build          # compile → test → lint
npm test
npm run lint           # oxlint, type-aware; warnings fail the build
npm run lint:fix
npx projen             # regenerate config after editing .projenrc.ts
```

```
packages/gcp-components   Pulumi ComponentResources — secure-by-default, typed args
packages/runway-cli       the CLI and the projen project type it scaffolds
docs/control-mapping.md   every control, its source, its tests, its policy rule
test/                     repo-level invariants — the pull-request gate
test-integration/         the tier that talks to GCP
SPEC.md                   capability map and toolchain; SPEC-<module>.md per module
```

**Never hand-edit a generated file.** `.projenrc.ts` is the single source of truth for every config
here, and `npx projen` rewrites the rest. Files carrying a projen marker will lose your changes.

### The toolchain is unusual for reasons

TypeScript 7 is the native compiler and **exposes no JavaScript compiler API**. Three consequences,
each measured rather than assumed:

- **ts-node cannot load**, so `.projenrc.ts` runs through Node's own type stripping. Pulumi stack
  programs are precompiled and declare `typescript: false` for the same reason — and compiling also
  turns a preview that never finished in two minutes into one that takes seconds.
- **ESLint is unusable** — `typescript-eslint` refuses to install alongside TS 7. oxlint parses
  TypeScript with its own Rust parser and needs no compiler API.
- **The policy pack needs its own install.** Pulumi's policy runner hardcodes ts-node on and falls
  back to its vendored TypeScript only when `require("typescript")` *throws* — TS 7 imports fine, it
  simply has no compiler API. `npm run policy:install --workspace @runway/gcp-components` builds a
  tree whose nearest resolvable TypeScript has one.

`.npmrc` ships `legacy-peer-deps=true` because `@pulumi/pulumi` declares a stale peer range npm
cannot resolve against TS 7. **The cost is repo-wide** — peer checking is off for every package — so
every `@pulumi/*` version is pinned exactly and asserted by test, and drift fails loudly.

[SPEC.md](SPEC.md) carries the full account.

## Not built yet

Stated plainly, because the specs describe more than exists:

- **`runway` is not published.** It runs from this repo; the registry decision is open
  ([SPEC.md](SPEC.md), open question 2), and a scaffolded repo depends on the CLI by local path.
- **No CLI flags and no `runway doctor`.** [SPEC-runway-cli.md](SPEC-runway-cli.md) describes
  `--gcp-project`, `--region` and `--dry-run`; none is implemented.
- **No Dockerfile is emitted.** The scaffold produces a service and its infrastructure, not an image
  build.
- **The integration tier is not scheduled.** It runs only when invoked by hand — the nightly
  workflow is unbuilt, so nothing is currently watching for regressions.
- **Three modules in the capability map are unbuilt**: `environment-provisioning`, `service-stacks`,
  and `release-path`. Staging and production environments, the identity boundary between them, and
  `runway deploy` all live there.
- **Binary Authorization (CR-09) is opt-in and unverified against real infrastructure.** It needs an
  attestor and org-level setup.

## Contributing

Read [SPEC.md](SPEC.md) first — it defines the capability map, the toolchain, and the boundaries.
The three that matter most:

- **Always** edit `.projenrc.ts` and run `npx projen`; add a control-mapping row *and* its test in
  the same commit as any new hardened default; keep the PR gate credential-free and offline.
- **Ask first** before adding a runtime dependency, changing a hardened default, adding an opt-out,
  or touching a real GCP project.
- **Never** commit a credential, emit a component that is public-by-default, or weaken a default to
  make a test pass.
