# Spec: Platform

Initiative-level spec. Defines shared toolchain, conventions, and the capability map.
Per-module specs: [SPEC-gcp-components.md](SPEC-gcp-components.md), [SPEC-runway-cli.md](SPEC-runway-cli.md).

## Objective

Give service teams a paved road onto GCP: one command produces a repository that builds,
tests, lints, and deploys a security-hardened Cloud Run service — with no security decisions
delegated to the team consuming it.

**Users**
- *Service developers* — want a running service today, are not GCP security experts, and will
  copy whatever the last team did if we give them nothing better.
- *Platform engineers* — own the guardrails, need hardening changes to propagate by version bump
  rather than by chasing teams.

**Success looks like:** a developer with no prior GCP knowledge runs `runway new`, commits, and
lands a private Cloud Run service running under a dedicated least-privilege service account,
pulling from a CMEK-capable Artifact Registry with immutable tags — without reading a single
security document.

## Capability Map

| Module id        | Responsibility                                                             | Depends on       |
|------------------|----------------------------------------------------------------------------|------------------|
| `gcp-components` | Pulumi `ComponentResource`s for GCP; secure-by-default, typed args          | —                |
| `runway-cli`     | projen-based CLI scaffolding a minimal service repo (build, CI, infra)      | `gcp-components` |

**Build order:** `gcp-components` → `runway-cli`

`runway-cli` is only worth shipping if the repo it emits actually deploys. Building
`gcp-components` first makes "scaffold a repo, `pulumi preview` succeeds against real components"
a genuine end-to-end acceptance test rather than a template compiling against nothing.

**Deferred third module.** Shared conventions (naming, labelling, project/env resolution) start as
an internal `src/conventions/` inside `gcp-components`. Extract to its own module only when
`runway-cli` needs them independently of the components — splitting now would buy a version
boundary before we know where the seam is.

## Tech Stack

Versions verified against the npm registry and the local toolchain on 2026-08-24.

| Concern            | Choice                     | Version   |
|--------------------|----------------------------|-----------|
| Language           | TypeScript                 | `7.0.2` (native compiler — see below) |
| Linter             | oxlint                     | `1.80.0`  |
| Type-aware lint    | `oxlint-tsgolint`          | `7.0.2001` |
| Runtime            | Node.js                    | `>=22`, dev on `26.3.0` |
| Repo/build manager | projen                     | `0.103.2` |
| Package manager    | npm workspaces             | `>=10`, dev on `11.16.0` |
| IaC engine         | `@pulumi/pulumi`           | `3.259.0` |
| GCP provider       | `@pulumi/gcp`              | `9.35.1`  |
| Policy as code     | `@pulumi/policy`           | `1.21.0`  |
| Test runner        | vitest                     | `4.1.11`  |
| Pulumi CLI         | `pulumi`                   | `3.246.0` (installed) |

**TypeScript 7 is the native compiler, and it has no JS compiler API.** `typescript@7.0.2` exports
exactly two symbols (`version`, `versionMajorMinor`) — no `ts.sys`, no `ts.createProgram`. Two
consequences, both verified rather than assumed:

- **ts-node cannot run**, so projen's default projenrc runner fails. `.projenrc.ts` is executed by
  Node's own type stripping instead (`TypeScriptRunner.nodejs()`), which needs no compiler API.
  This is why `minNodeVersion` is `22.18.0`.
- **ESLint is unusable.** `typescript-eslint` throws on import — *"typescript-eslint does not
  support TS 7.0"* — and its peer range caps at `<6.1.0`, so it cannot even install
  ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940)).

`tsc` and vitest both work on TS 7 — only the tools that link against the compiler API are affected.

**A third casualty, found in C2: `@pulumi/pulumi` cannot be installed at all without help.** It
declares `peerDependencies: { typescript: ">= 3.8.3 < 7", "ts-node": ">= 7.0.1 < 12" }`, so npm
refuses to resolve it alongside `typescript@7.0.2` and fails `ERESOLVE`. Both peers are marked
optional and nothing needs them at runtime — the range is stale metadata, not a real constraint.

The repo therefore ships a projen-generated `.npmrc` containing `legacy-peer-deps=true`. **The cost
is real and repo-wide:** peer checking is disabled for every package, so a genuinely incompatible
peer elsewhere will now install silently instead of erroring. What replaces that check is exact
pinning of every `@pulumi/*` version plus tests asserting those pins, so drift fails loudly.

**And ts-node's breakage reaches further than projen.** Pulumi runs `.ts` programs through ts-node,
which throws under TS 7 (`ts.sys` is undefined). For a **stack program**, Pulumi loads ts-node only
when `PULUMI_NODEJS_TYPESCRIPT === "true"` (`@pulumi/pulumi/cmd/run/run.js:234`), set from
`runtime.options.typescript` in `Pulumi.yaml`. **Every stack must therefore be precompiled and
declare `typescript: false`.** Confirmed by a real `pulumi preview` against the sandbox project: the
stack planned six resources with no ts-node involved.

> **Correction (found in the integration run, after this was first written).** An earlier version of
> this paragraph extended that mitigation to policy packs. **It does not apply to them.** The
> policy-pack runner is a different code path and hardcodes ts-node on:
> `typeScript: !process.versions.bun` (`@pulumi/pulumi/cmd/run-policy-pack/index.js:110`). It never
> reads `PulumiPolicy.yaml`'s runtime options, so `typescript: false` there is inert.
>
> What actually governs it is `typeScriptRequireStrings()` (`@pulumi/pulumi/tsutils.js`): Pulumi
> falls back to its vendored `typescript@3.8.3` **only when `require("typescript")` throws**. TS 7
> imports fine — it simply has no compiler API — so the fallback never fires, and the vendored
> ts-node then dies on `ts.sys.readFile`.
>
> **Consequence, and the mechanism that resolves it.** The requirement is that the **nearest
> resolvable `typescript` has a compiler API** — not, as first recorded, that none resolves at all.
> `npm run policy:install --workspace @runway/gcp-components` builds a tree satisfying that, and its
> four load-bearing properties are documented and test-asserted in
> [SPEC-secure-container-service.md](SPEC-secure-container-service.md#hardening-controls). Verified
> end to end against a TypeScript 7 consumer, in both directions.

Verified alongside: `tsc` 7 typechecks Pulumi components cleanly and vitest drives
`pulumi.runtime.setMocks()` without issue, so only the ts-node paths are affected.

**oxlint is the linter, and it sidesteps the problem entirely.** oxlint parses TypeScript with its
own Rust parser (oxc) and has **zero runtime dependencies**, so it never touches the compiler API
that TS 7 removed. Type-aware rules come from the optional `oxlint-tsgolint` peer, which is itself
powered by typescript-go — the same compiler we already build with. Both verified against
`typescript@7.0.2`: plain oxlint flags `no-unused-vars`, and `--type-aware` flags
`no-floating-promises`, a rule that cannot work without type information.

This is not a downgrade from typescript-eslint. It is the same class of check, on a toolchain that
actually supports TS 7.

**projen has no oxlint component** (verified — `projen/lib` contains no oxlint or oxc references),
so `eslint: false` stays set and the lint task is registered by hand in `.projenrc.ts`. That hand-
wiring is the cost of the choice, and it is small: one `addTask` call.

**Monorepo mechanics.** projen natively supports subprojects via `parent` + `outdir` on `Project`
(verified in `projen/lib/project.d.ts:34,46`). The root `.projenrc.ts` declares both packages. All
files under `packages/*` that projen owns are generated — never hand-edited.

**The workspace array is hand-wired, and that is a known cost.** projen ships a first-class
`PnpmWorkspaceConfig` component and **no npm equivalent** — searching `projen/lib` for non-pnpm
workspace handling turns up nothing. With npm, the root `package.json` `workspaces` array is set
through the escape hatch:

```ts
root.package.addField("workspaces", ["packages/*"]);   // projen/lib/javascript/node-package.d.ts:737
```

This works, but no projen component maintains it — a projen upgrade will not keep it correct.
Accepted deliberately: npm is installed everywhere Node is, and the alternative was a package
manager absent from the development machine.

## Commands

Run from the repo root.

```bash
# Regenerate all projen-managed files after editing .projenrc.ts
npx projen

# Build every package (tsc + bundle)
npm run build --workspaces

# Test with coverage
npm test --workspaces -- --coverage

# Lint (type-aware). --deny-warnings is what makes it a gate rather than a report.
npx oxlint --type-aware --deny-warnings

# Lint, autofixing what is fixable
npx oxlint --type-aware --fix

# Typecheck without emitting
npx tsc --noEmit

# Single package
npm test --workspace @runway/gcp-components
npm run build --workspace @runway/cli

# Run the CrossGuard policy pack against a stack
pulumi preview --policy-pack packages/gcp-components/policy
```

## Project Structure

```
platform/
├─ .projenrc.ts                  → Single source of truth for all generated config
├─ package.json                  → Generated by projen; carries the `workspaces` array
├─ SPEC.md                       → This file
├─ SPEC-gcp-components.md        → Module spec (build first)
├─ SPEC-runway-cli.md            → Module spec (build second)
├─ docs/
│  └─ control-mapping.md         → Hardening control → external standard → test
├─ tasks/                        → plan.md and todo.md (Phase 2/3 output)
└─ packages/
   ├─ gcp-components/
   │  ├─ src/
   │  │  ├─ conventions/         → Naming, labels, env resolution (internal)
   │  │  └─ <service>/           → One directory per component
   │  ├─ policy/                 → CrossGuard policy pack
   │  └─ test/                   → Mirrors src/ layout
   └─ runway-cli/
      ├─ src/
      │  ├─ commands/            → One file per CLI verb
      │  └─ templates/           → projen project types emitted into new repos
      └─ test/
```

## Code Style

One real component. This is the house style — match it.

```ts
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

export interface SecureContainerServiceArgs {
  /** Region, e.g. "europe-west1". */
  readonly location: pulumi.Input<string>;
  /** Fully-qualified image reference, digest-pinned in production. */
  readonly image: pulumi.Input<string>;
  /** Runtime identity. Required — never falls back to the default compute SA. */
  readonly serviceAccount: SecureServiceAccount;
  /**
   * Expose the service to the public internet. Opt-out from the hardened default.
   * @default false
   */
  readonly publicAccess?: false | { readonly justification: string };
}

export class SecureContainerService extends pulumi.ComponentResource {
  public readonly service: gcp.cloudrunv2.Service;
  public readonly uri: pulumi.Output<string>;

  constructor(
    name: string,
    args: SecureContainerServiceArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super("runway:gcp:SecureContainerService", name, {}, opts);

    const isPublic = args.publicAccess !== undefined && args.publicAccess !== false;

    this.service = new gcp.cloudrunv2.Service(
      name,
      {
        location: args.location,
        deletionProtection: true,
        ingress: isPublic
          ? "INGRESS_TRAFFIC_ALL"
          : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
        template: {
          serviceAccount: args.serviceAccount.email,
          containers: [{ image: args.image }],
        },
      },
      { parent: this },
    );

    this.uri = this.service.uri;
    this.registerOutputs({ service: this.service, uri: this.uri });
  }
}
```

**Conventions**
- Named exports only; no default exports.
- Args interfaces are `<Component>Args`, every member `readonly`, every member doc-commented.
- Pulumi type strings are namespaced `runway:gcp:<Component>`.
- Every child resource passes `{ parent: this }`; every component ends with `registerOutputs`.
- **Unsafe options are discriminated opt-outs carrying a justification string, not bare booleans.**
  `publicAccess: { justification: "..." }` rather than `publicAccess: true`. This makes every
  escape hatch visible in code review and greppable across all consuming repos — the single most
  valuable convention in this spec.
- No `any`. No non-null assertions (`!`) outside tests.
- Prettier defaults, 2-space indent, trailing commas, 100-column print width.

## Testing Strategy

| Level          | Tool                          | Runs on   | Gate |
|----------------|-------------------------------|-----------|------|
| Unit           | vitest + `pulumi.runtime.setMocks()` | Every PR  | Blocking |
| Policy         | vitest against the policy pack | Every PR  | Blocking |
| Generation     | vitest — scaffold to temp dir, build it | Every PR  | Blocking |
| Integration    | `pulumi preview` on a real GCP project | Nightly + pre-release | Non-blocking on PR |

- Tests live in `test/`, mirroring `src/`. Filenames `<subject>.test.ts`.
- Unit tests use Pulumi mocks — **no test in the PR gate may touch GCP or need credentials.**
- **Every hardening control in `docs/control-mapping.md` has exactly one named test asserting it.**
  A control without a test is not a control. This is the coverage metric that matters.
- Line coverage floor: 80% per package. The control-mapping completeness check is separate and absolute.

## Boundaries

**Always**
- Edit `.projenrc.ts` and run `npx projen` — never hand-edit a projen-generated file.
- Add a control-mapping row *and* its test in the same commit as any new hardened default.
- Keep the PR test gate credential-free and offline.
- Pin exact versions for `@pulumi/*` packages; caret ranges only for dev tooling.

**Ask first**
- Adding a runtime dependency to either package.
- Changing a hardened default, or adding a new opt-out escape hatch.
- Any change to the generated repo's CI workflow shape.
- Widening v1 scope beyond Cloud Run + Artifact Registry + service account.
- Creating, modifying, or destroying real GCP resources in any project.

**Never**
- Commit service account keys, `.pulumi/` state, or any credential — the components must make
  user-managed SA keys impossible to create through the library.
- Emit a component that is public-by-default.
- Weaken a default to make a test pass.
- Run `pulumi up` or `pulumi destroy` unattended, or against a project not designated as sandbox.

## Success Criteria

1. `npm install && npx projen && npm run build --workspaces && npm test --workspaces` passes from a
   clean clone with no GCP credentials present. Install precedes `projen`: `.projenrc.ts` imports
   `projen`, so it cannot execute before `node_modules` exists.
2. `runway new my-service` produces a repo that, unmodified, passes its own `build`, `test`, `lint`.
3. That generated repo's `pulumi preview` succeeds against a real GCP project and plans exactly:
   one Artifact Registry repo, one service account, one Cloud Run service — and nothing public.
4. Every row in `docs/control-mapping.md` links to a passing named test.
5. The CrossGuard policy pack fails `pulumi preview` on a stack that declares a raw
   `gcp.cloudrunv2.Service` with `ingress: "INGRESS_TRAFFIC_ALL"` and no justification.
6. Both packages publish with independent semver tags from the monorepo.

## Open Questions

1. **CIS coverage is thin for this v1 scope — needs a decision.** The CIS GCP Foundations
   Benchmark has no Cloud Run or Artifact Registry section; its sections cover IAM, logging,
   networking, VMs, Storage, Cloud SQL, and BigQuery. Of our three v1 components, only the service
   account maps cleanly (the IAM controls on user-managed keys and on over-privileged accounts).
   I will **not** invent CIS control IDs for Cloud Run. Proposal: `docs/control-mapping.md` carries
   a `Source` column citing CIS where a control genuinely exists and Google's Cloud Run security
   guidance otherwise. Confirm that is acceptable, or defer the mapping doc until v2 widens scope
   into Storage/Cloud SQL where CIS actually bites.
2. **Package registry and scope.** `@runway/*` is a placeholder. npm public, GitHub Packages, or
   Artifact Registry npm? This changes CI publish config and the generated repo's `.npmrc`.
3. ~~**Integration test target.**~~ **RESOLVED — `enduring-badge-506610-u9`** (project number
   `741165637912`) is the designated integration project. Nothing is created there: only
   `pulumi preview` is run, against a **local file backend**, so no state reaches Pulumi Cloud
   either. Confirmed empty before and after the run.
   - **No service accounts and no deployed workloads.** That is what makes it usable as a sandbox.
   - **API state, corrected.** An earlier note here claimed none of the relevant APIs were enabled.
     That was wrong: `run.googleapis.com`, `artifactregistry.googleapis.com` and
     `serviceusage.googleapis.com` are **enabled**; `iam.googleapis.com`,
     `cloudresourcemanager.googleapis.com` and `binaryauthorization.googleapis.com` are not. The
     original claim came from a `grep` that returned nothing — which cannot distinguish "no matches"
     from "the command failed", the same absence-versus-nothing-happened trap this repo's tests keep
     catching. Enabled state is now read per-API by exact match.
   - `preview` needs no APIs enabled at all. `pulumi up` is still a separate decision that has not
     been taken; billing is active (`billingAccounts/01A131-8B0806-3C46A4`) and the account holds
     `roles/owner`, so nothing blocks it technically.
   - `project-4da1a7fd-3681-4524-853` was briefly used first and should **not** be used again: it
     holds live workloads and service accounts (`piper-image-builder`, `app-image-builder`,
     `qwen2vl-image-builder`), so it is not a sandbox in any meaningful sense.
4. **Binary Authorization.** `deletionProtection: true` is a safe default, but Binary Authorization
   requires an attestor and org-level setup. Default it on and require the attestor arg, or leave
   it opt-in for v1?
5. **CLI distribution.** npm global install (`npm i -g @runway/cli`) versus `npx runway`, versus a
   projen external project type (`npx projen new --from @runway/cli`). Affects `runway-cli`'s spec.
