# platform

A paved road onto GCP. One command produces a repository that builds, tests, lints, and deploys a
security-hardened Cloud Run service — with no security decisions delegated to the team consuming it.

The premise is that a service team should not have to be a GCP security expert to ship safely, and
that hardening should propagate by version bump rather than by chasing teams. So the guardrails are
components, not documentation: defaults you get for free and have to work to opt out of, with the
justification recorded on the resource when you do.

## Repository layout

```
packages/gcp-components   Pulumi ComponentResources — secure-by-default, typed args
packages/runway-cli       projen-based CLI that scaffolds a service repo
docs/control-mapping.md   every hardening control, its source, its tests, its policy rule
test/                     repo-level invariants — the pull-request gate
test-integration/         the nightly tier, against a real GCP sandbox
SPEC.md                   initiative spec and capability map; SPEC-<module>.md per module
tasks/                    plans and task lists
```

## Getting started

```bash
npm install        # must precede projen: .projenrc.ts imports it
npm run build      # compile, test, lint across every package
```

`build` is credential-free and offline. It is the whole pull-request gate.

## Commands

```bash
npm run build                     # compile → test → lint, all packages
npm test                          # tests only
npm run lint                      # oxlint, type-aware; warnings fail the build
npm run lint:fix
npx projen                        # regenerate config after editing .projenrc.ts
```

**Never hand-edit a generated file.** `.projenrc.ts` is the single source of truth for every
config in the repo; `npx projen` rewrites the rest. A file with a projen marker at the top will
have your changes overwritten.

## What the components guarantee

Sixteen controls, catalogued in [docs/control-mapping.md](docs/control-mapping.md) — each with the
Google guidance it rests on, the component that applies it, the tests that prove it, and the
CrossGuard rule that catches consumers who bypass the component entirely.

| Component | Guarantees |
|---|---|
| `SecureContainerService` | Private ingress by default; no public invoker binding without a written justification recorded on the resource; a user-managed runtime identity; deletion protection on |
| `SecureServiceAccount` | User-managed keys impossible to create through the library; no roles granted unless named; project-wide and `*admin` roles rejected |
| `SecureArtifactRepository` | Immutable Docker tags with no opt-out; vulnerability scanning never disabled; retention that actually deletes |

**That document is checked by a test, in both directions.** A control without a row fails, and a
row without a test fails. A mapping that has drifted from its suite is worse than no mapping,
because it reads as proof.

## Scaffolding a service

```bash
runway new <service-name>
```

Produces a projen-managed repository: build, test, lint, CI, and a deployable infrastructure stack
composed from the components above. Minimal is a hard constraint — every generated line is a line
someone has to read, and a scaffold that emits two thousand of them gets deleted and hand-rolled.

## Testing

Four tiers, and the split between them is deliberate.

| Tier | What it proves | Runs |
|---|---|---|
| Unit | The plan has the right shape (`pulumi.runtime.setMocks`) | every PR, blocking |
| Policy | The CrossGuard pack catches bypasses | every PR, blocking |
| Generation | The scaffold emits a repo that builds | every PR, blocking |
| Integration | GCP accepts and enforces what we planned | nightly, non-blocking |

**No test in the pull-request gate may touch GCP or need credentials.** Fork contributors cannot
hold credentials, and a gate that needs them makes every external contribution red.

### The integration tier

```bash
export GOOGLE_CLOUD_PROJECT=enduring-badge-506610-u9   # the only project it will run against
gcloud auth application-default login

npm run test:integration            # both tiers, then the leak check
npm run test:integration:preview    # plans against real GCP, creates nothing
npm run test:integration:deploy     # deploys, asserts, destroys
```

It exists for what mocks cannot see: whether the provider still accepts our resource shapes,
whether a policy rule resolves through the engine's real dependency graph, and whether GCP reports
back what Pulumi thinks it asked for. **It reads deployed state through the GCP API, never through
Pulumi state** — state records what we asked for, the API reports what GCP did, and CR-06 is the
standing proof that these differ.

A guard refuses to run against any project but the designated sandbox, and it is tested in the
pull-request gate rather than only in the tier it protects.

**Not an emulator, deliberately.** LocalStack has no GCP support, and the third-party GCP emulators
do not implement IAM enforcement, Artifact Registry, or Binary Authorization — which is most of
what this repo hardens. An emulator returns `200 OK` for a wide-open `allUsers` binding as readily
as for a locked-down one, so the suite could not fail on a security regression. See
[SPEC-integration-tests.md](SPEC-integration-tests.md).

## The toolchain, and why it is unusual

TypeScript 7 is the native compiler and **exposes no JavaScript compiler API**. Three consequences,
each verified rather than assumed:

- **ts-node cannot load**, so `.projenrc.ts` runs through Node's own type stripping instead. Pulumi
  stack programs are precompiled and declare `typescript: false` for the same reason.
- **ESLint is unusable** — `typescript-eslint` refuses to install alongside TS 7. oxlint parses
  TypeScript with its own Rust parser and needs no compiler API.
- **The CrossGuard policy pack needs its own install.** Pulumi's policy runner hardcodes ts-node on
  and falls back to its vendored TypeScript only when `require("typescript")` *throws* — TS 7
  imports fine, it simply has no compiler API. `npm run policy:install --workspace
  @runway/gcp-components` builds a tree where the nearest resolvable TypeScript has one.

`.npmrc` ships `legacy-peer-deps=true` because `@pulumi/pulumi` declares a stale peer range that
npm cannot resolve against TS 7. **The cost is repo-wide** — peer checking is off for every package
— so every `@pulumi/*` version is pinned exactly and asserted by test, and drift fails loudly.

[SPEC.md](SPEC.md) carries the full account.

## Contributing

Read [SPEC.md](SPEC.md) first — it defines the capability map, the toolchain, and the boundaries.
Three that matter most:

- **Always** edit `.projenrc.ts` and run `npx projen`; add a control-mapping row *and* its test in
  the same commit as any new hardened default; keep the PR gate credential-free and offline.
- **Ask first** before adding a runtime dependency, changing a hardened default, adding an opt-out,
  or touching a real GCP project.
- **Never** commit a credential, emit a component that is public-by-default, or weaken a default to
  make a test pass.
