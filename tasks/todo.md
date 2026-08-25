# Tasks: gcp-components — SecureContainerService

Eight tasks, four checkpoints. Rationale, verified toolchain findings, and risks:
[tasks/plan.md](plan.md). Spec: [SPEC-secure-container-service.md](../SPEC-secure-container-service.md).

- **Phase A — Foundation** (C1–C2): npm workspaces, and proof that Pulumi works on TypeScript 7.
- **Phase B — Component** (C3–C6): the validator, the private default, the justified opt-out,
  Binary Authorization.
- **Phase C — Enforcement** (C7–C8): the policy pack for consumers who bypass the component, and a
  control-mapping doc that cannot drift from the suite.

Strictly sequential. C5 and C6 both depend on C4 but edit the same file, so they do not parallelise.

The **runway-cli prototype tasks are deferred, not dropped** — see [Deferred](#deferred-runway-cli-prototype)
at the bottom. Component tasks use a `C` prefix so that plan's numbering stays valid.

---

## Phase A: Foundation

### ✅ C1: Restructure to npm workspaces — DONE
Move `@runway/cli` from the repo root into `packages/runway-cli` and make the root a private
workspace root. This task adds **no new package content** — its whole job is to prove the move is
non-destructive before anything is built on top of it.

**Acceptance criteria**
- [x] `.projenrc.ts` declares a private root with subprojects via `parent` + `outdir`;
      `@runway/cli` becomes `packages/runway-cli` with its config unchanged.
      **Correction: the root is a `typescript.TypeScriptProject`, not a `NodeProject`.**
      `projenrcTs` is declared only on `TypeScriptProjectOptions`, and the standalone
      `typescript.Projenrc` component takes a `TypeScriptProject` in its constructor — so a
      `NodeProject` root would have meant hand-rolling the projenrc task and losing
      `projenrc/tsconfig.json`. The root compiles nothing: `compileTask` and `packageTask` are
      reset to fan out and to no-op respectively.
- [x] The root `package.json` carries `workspaces: ["packages/*"]`, set through
      `package.addField` — projen ships `PnpmWorkspaceConfig` and no npm equivalent
- [x] Root `build`, `test`, and `lint` tasks fan out across workspaces
- [x] `oxlint` runs once from the root over both packages, still `--type-aware --deny-warnings`

**Verification**
- [x] **The existing runway-cli tests still pass** — the acceptance test for the whole task.
      **Criterion amended: "unmodified" was wrong.** Eight of the fifteen failed after the move,
      all for one reason — they asserted *repo-level* facts (oxlint pins, `.oxlintrc.json`,
      the package manager, the location of the oxlint binary) from inside a package where those
      facts are no longer true. npm workspaces deliberately keeps one lockfile and one hoisted
      `node_modules` at the root, so those assertions could only be made to pass by walking out
      of the package they claimed to be testing. They were **relocated to the root**, not patched.
      `packages/runway-cli/test/toolchain.test.ts` keeps only what is genuinely per-package: its
      TypeScript pin, its vitest pin, and its bin entry. Count is now 25 root + 3 package = 28.
- [x] `npm install && npx projen && npm run build && npm test && npm run lint` passes from a clean clone
- [x] `npx projen` twice produces zero diff on the second run
- [x] A test asserts the root `workspaces` array contains `packages/*` — projen does not maintain it,
      so an upgrade that silently drops it must fail loudly rather than degrade
- [x] Tests assert there is **exactly one lockfile**: a nested `packages/*/package-lock.json` would
      silently defeat hoisting. One appeared during the transition and is now asserted against
- [x] Tests prove a **single root oxlint pass reaches into `packages/`** and applies the root
      `.oxlintrc.json` there — verified empirically that oxlint discovers config by walking up,
      so no `-c` flag is needed in subprojects
- [x] No `yarn.lock` or `pnpm-lock.yaml` appears

**Dependencies:** None
**Files:** `.projenrc.ts`, `test/workspaces.test.ts` (new), `test/toolchain.test.ts` (repo-level,
relocated), `test/lint-gate.test.ts` (extended with workspace coverage),
`packages/runway-cli/test/toolchain.test.ts` (reduced to per-package), + `git mv` of `src/`
**Scope:** M — the edits are few; the moves are mechanical

---

**Findings worth carrying forward**
- projen has **no npm-workspaces awareness whatsoever**: `NodePackage.postSynthesize` installs
  per project with no parent guard (`node-package.js:609-626`), and the only parent-aware branch in
  the file is for pnpm overrides. From a clean tree npm reconciles correctly, but the transition
  produced a nested lockfile and nested `node_modules` before it settled.
- The root's `rootDir` must be widened to `"."`. projen defaults it to `srcdir`, and with the root
  holding only `test/`, `tsc --noEmit` failed TS6059 on its own test files.
- oxlint discovers `.oxlintrc.json` by walking up from the working directory — verified with a rule
  only the root config enables — so one config governs every package.

### ✅ C2: Add the gcp-components package and prove the Pulumi/TS 7 toolchain — DONE
Create the second package and retire the plan's highest risk with a test rather than an assertion.
[tasks/plan.md](plan.md#toolchain-findings-verified-not-assumed) records what was verified in
scratch; this reproduces it inside the repo.

**Acceptance criteria**
- [x] `packages/gcp-components` exists as a projen subproject named `@runway/gcp-components`
- [x] `@pulumi/pulumi` and `@pulumi/gcp` are pinned **exactly** (no caret) per
      [SPEC.md](../SPEC.md#boundaries). **[plan OQ4](plan.md#open-questions) resolved: `9.35.1`** —
      the whole Cloud Run arg surface in the component spec was verified against it, and SPEC.md's
      `9.35.0` pin predated that verification. SPEC.md's table is updated to match.
- [x] **Beyond the stated criteria: `@pulumi/*` are `peerDeps`, not `deps`.** Two copies of
      `@pulumi/pulumi` in one program break resource registration, and a published library that
      bundles its own copy makes that the consumer's problem — moving `deps` → `peerDeps` later
      would be a breaking change. projen also pins them as devDeps
      (`peerDependencyOptions.pinnedDevDependency`), so tests still resolve them.
- [x] `.npmrc` with `legacy-peer-deps=true` is **projen-generated**, and carries a comment
      explaining that `@pulumi/pulumi` peer-caps TypeScript at `<7` while marking it optional
- [x] `test/setup.ts` installs `pulumi.runtime.setMocks()` with no network and no credentials

**Verification**
- [x] A smoke test constructs a mocked `gcp.cloudrunv2.Service` and resolves one `Output` — proving
      findings 2 and 3 hold **inside this repo**, not just in a scratch directory
- [x] `npx tsc --noEmit` is clean across both packages with lib checking on
- [x] A test asserts the pinned `@pulumi/*` versions, so the check `legacy-peer-deps` disables is
      replaced by one that fails loudly
- [x] `npm install` from a clean clone succeeds with **no** `--legacy-peer-deps` flag on the command
      line — the `.npmrc` must be doing the work
- [x] Full root chain green; `npx projen` twice still zero diff

**Dependencies:** C1
**Files:** `.projenrc.ts`, `.npmrc` (generated), `packages/gcp-components/test/setup.ts`,
`packages/gcp-components/test/toolchain.test.ts`
**Scope:** M — carries the plan's highest risk

---

**Findings worth carrying forward**
- **`.npmrc` has a bootstrap deadlock.** projen installs each subproject during `postSynthesize`,
  which runs *before* the root writes its files — so on a tree with no `.npmrc`, adding the first
  Pulumi package makes `npx projen` fail `ERESOLVE` and the `.npmrc` that would have fixed it is
  never written. Harmless on a clean clone, where `.npmrc` is committed and present before
  `npm install`; it bites only when bootstrapping the file itself. Written by hand once, then
  handed to projen.
- **The lint gate caught a real defect in this task's own code.** `pulumi.runtime.setMocks` is
  declared `async` and returns `Promise<void>`, so `no-floating-promises` fired on `test/setup.ts`.
  Its body contains no `await` — it installs the mock monitor and sets feature flags synchronously
  (`@pulumi/pulumi/runtime/mocks.js`) — so there is **no race today** and `void` is correct. The
  reasoning is recorded in the file, with the trigger for revisiting it: if a future Pulumi release
  makes that body genuinely async, the fix is to export the promise and await it in `beforeAll`.
- `src/index.ts` exports `TYPE_NAMESPACE = "runway:gcp"` rather than an empty `export {}`, which
  oxlint rejects. Not filler: SPEC.md requires components to register as `runway:gcp:<Component>`,
  so the prefix is written down once where C3 onward can use it.

### ✅ Checkpoint: Toolchain Proven
- [ ] Pulumi components typecheck and unit-test on TypeScript 7, proven by a test in the PR gate
- [ ] Both packages build, test, and lint from a clean clone with no credentials
- [ ] **Decide [plan OQ4](plan.md#open-questions)** — `@pulumi/gcp` 9.35.0 or 9.35.1 — and update
      [SPEC.md](../SPEC.md#tech-stack) to match
- [ ] Human review

---

## Phase B: Component

### ✅ C3: Service-account email validator — DONE
`assertUserManagedServiceAccount` — a pure function, no Pulumi, no mocks. Carries **CR-04**, the
control now doing the most work because the typed `SecureServiceAccount` guarantee is deferred.

**Acceptance criteria**
- [x] Positive rule: accepts only `<id>@<project>.iam.gserviceaccount.com`. Google-managed defaults
      are rejected **by falling outside the rule**, not by being enumerated
- [x] Known defaults (compute, App Engine, Cloud Build) are pattern-matched **only to improve the
      error message** — never as the security boundary
- [x] Errors name the corrective action, not just the fault
- [x] Exported from the package's `src/index.ts`

**Verification**
- [x] Table-driven test over the three Google-managed defaults, a human email, and a malformed
      address — each asserting rejection *and* that the message names the fix
- [x] Boundary cases: 6-character id accepted, 5 rejected; 30 accepted, 31 rejected
- [x] Leading digit, uppercase, and trailing hyphen rejected
- [x] `npm test --workspace @runway/gcp-components -- -t "CR-04"` passes

**Dependencies:** C2
**Files:** `packages/gcp-components/src/container-service/service-account-email.ts`,
`packages/gcp-components/src/index.ts`,
`packages/gcp-components/test/container-service/service-account-email.test.ts`
**Scope:** S

---

**Findings worth carrying forward**
- **This task's own verification command was a silent no-op.**
  `npm test --workspace @runway/gcp-components -- -t "CR-04"` ran the *entire* suite and exited 0.
  projen accepts trailing args and never forwards them to the step, so the filter was ignored
  without any warning. Fixed with `receiveArgs: true` on both packages' test steps, and
  `test/toolchain.test.ts` now asserts it so the silence cannot return. **The same trap applies to
  every other projen task in this repo** — `lint` included — for any flag someone passes after `--`.
- **`--coverage` was doubly broken.** Once args actually forwarded, it failed
  `MISSING DEPENDENCY @vitest/coverage-v8`. That flag is documented in three spec files and
  [SPEC.md](../SPEC.md#testing-strategy) sets an 80% line-coverage floor, so the provider was added
  (a devDep, not gated by the ask-first rule on *runtime* deps). gcp-components now reports 92.3%.
- **The positive rule's guarantee is narrower than it first appears, and the code says so.**
  Some Google-managed *service agents* do live under `.iam.gserviceaccount.com` (e.g.
  `service-<n>@gcf-admin-robot.iam.gserviceaccount.com`) and will pass. What CR-04 actually
  guarantees is that the over-privileged **default runtime identities** cannot be used — not that
  the account is never Google-managed. Overclaiming that in a security control would be worse than
  the gap itself.
- A test asserts an *unlisted* future Google default is still rejected, proving the hint list is
  only cosmetic and the positive rule is the real boundary.

### C4: SecureContainerService — private default path
The component itself, hardened defaults only. Carries **CR-01, CR-04, CR-05, CR-06, CR-07**.

**Acceptance criteria**
- [ ] Three required args (`location`, `image`, `serviceAccountEmail`) produce: ingress
      `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, `defaultUriDisabled: true`,
      `deletionProtection: true`, no IAM member, no `description`, no `runway-public` label
- [ ] `invokerIamDisabled` is **not exposed and never set** — it disables the IAM check on
      `run.routes.invoke`, a wider hole than `allUsers` and invisible in an IAM policy dump
- [ ] `serviceAccountEmail` validates synchronously for a plain string and inside `.apply()` for an
      `Output`; the arg stays `pulumi.Input<string>` so C-future can accept `SecureServiceAccount.email`
      without a breaking change
- [ ] `deletionProtection` opt-out is the discriminated justified form, matching the house convention
- [ ] TSDoc on `uri` states that the private path disables default-URI resolution, and TSDoc on the
      class states a default-constructed service is **unreachable until a load balancer is added** —
      otherwise the first developer to hit it "fixes" it with `publicAccess`
- [ ] `vpcAccess`, `encryptionKey`, and `iapEnabled` appear **nowhere** in the args interface

**Verification**
- [ ] One named `it` per control, named after its control-mapping row
- [ ] Assertions are on resolved `Output` values, never on constructor arguments
- [ ] Both validation paths tested: plain string throws at construction; `Output` rejects on resolution
- [ ] `npm test --workspace @runway/gcp-components` passes with no `GOOGLE_APPLICATION_CREDENTIALS`

**Dependencies:** C3
**Files:** `packages/gcp-components/src/container-service/secure-container-service.ts`,
`packages/gcp-components/src/index.ts`,
`packages/gcp-components/test/container-service/secure-container-service.test.ts`
**Scope:** M

---

### ✅ Checkpoint: Private Default Works
- [ ] A service built from three args alone is private, protected, and running under a validated SA
- [ ] Every assertion resolves an `Output`; none inspect constructor input
- [ ] Suite runs offline, no credentials
- [ ] Human review

---

### C5: Public access path — the justified opt-out
The escape hatch, and the auditability that makes it acceptable. Carries **CR-02, CR-03, CR-08**.

**Acceptance criteria**
- [ ] `publicAccess: { justification }` simultaneously sets ingress `INGRESS_TRAFFIC_ALL`,
      `defaultUriDisabled: false`, emits one `allUsers` `roles/run.invoker` binding, writes
      `description`, and sets `labels["runway-public"] = "true"`
- [ ] An empty or whitespace-only justification is **rejected** — it satisfies the type and defeats
      the control
- [ ] The justification reaches `description` **verbatim**; it is not written to a label, which GCP
      would reject (label values: lowercase alphanumerics, `-`, `_`, ≤63 chars)

**Verification**
- [ ] Justification round-trips into `description` unmodified
- [ ] `labels["runway-public"]` is a valid GCP label value
- [ ] Public path emits exactly one `ServiceIamMember`; private path emits zero
- [ ] Empty and whitespace-only justifications both throw
- [ ] `npm test --workspace @runway/gcp-components -- -t "CR-0[238]"` passes

**Dependencies:** C4
**Files:** `packages/gcp-components/src/container-service/secure-container-service.ts`,
`packages/gcp-components/test/container-service/secure-container-service.test.ts`
**Scope:** S

---

### C6: Binary Authorization — opt-in
Carries **CR-09**. Note the verified type has **no attestor field**: it is
`{ useDefault, policy, breakglassJustification }`, which closes
[SPEC.md OQ4](../SPEC.md#open-questions) on different terms than it was asked.

**Acceptance criteria**
- [ ] `binaryAuthorization` accepts `{ useDefault: true }` or `{ policy }`, and is **absent by
      default** — `useDefault` fails every deployment in a project with no BinAuthz policy, which is
      not a default a library may impose
- [ ] `breakglassJustification` is **not exposed through any public API** — it is the documented way
      to bypass the policy this control exists to apply
- [ ] Omitting the arg emits no `binaryAuthorization` block at all, rather than an empty one

**Verification**
- [ ] Test asserts the emitted block for each of the two accepted forms
- [ ] Test asserts no `binaryAuthorization` key is emitted when the arg is omitted
- [ ] A type-level or structural test asserts `breakglassJustification` is unreachable from `SecureContainerServiceArgs`
- [ ] `npm test --workspace @runway/gcp-components -- -t "CR-09"` passes

**Dependencies:** C4
**Files:** `packages/gcp-components/src/container-service/secure-container-service.ts`,
`packages/gcp-components/test/container-service/secure-container-service.test.ts`
**Scope:** S

---

### ✅ Checkpoint: Component Complete
- [ ] All nine CR-* controls hold, each with a named test
- [ ] Negative tests exist for every opt-out; no control has only a happy path
- [ ] `vpcAccess`, CMEK, and IAP are absent from the public surface
- [ ] **Resolve [plan OQ2](plan.md#open-questions)** before C7 — whether an out-of-band removal of
      `runway-public` may be allowed to defeat CR-03 decides the policy rule's shape
- [ ] Human review

---

## Phase C: Enforcement

### C7: CrossGuard policy pack
The layer that catches the bypass case: a consumer who declares a raw `gcp.*` resource and skips the
component entirely. Built with `PolicyPack` + `validateResourceOfType`, `enforcementLevel: "mandatory"`.

**Acceptance criteria**
- [ ] Rules reject: ingress `INGRESS_TRAFFIC_ALL` without a `runway-public` label; `invokerIamDisabled: true`;
      `template.serviceAccount` absent or not `*.iam.gserviceaccount.com`; an `allUsers`/`allAuthenticatedUsers`
      `roles/run.invoker` binding on a service with no `runway-public` label; any `breakglassJustification`
- [ ] The absent-serviceAccount rule is present and tested — the API types that field
      `Input<string | undefined>`, so omitting it is legal and silently yields the default compute SA
- [ ] The pack is **precompiled JS** and its `Pulumi.yaml` (or equivalent) sets
      `runtime.options.typescript: false` — ts-node cannot load under TS 7, so a `.ts` policy pack
      will not run at all ([plan finding 5](plan.md#toolchain-findings-verified-not-assumed))

**Acceptance criteria — stop conditions**
- [ ] If policy rules cannot be unit-tested under vitest without booting a real stack, **stop and
      report**. Do not weaken a rule to make it testable.

**Verification**
- [ ] Each rule has a test asserting it fires on the violating resource and stays silent on the
      compliant one
- [ ] A stack using only `SecureContainerService` passes with zero violations
- [ ] `npm test --workspace @runway/gcp-components -- -t "policy"` passes, offline

**Dependencies:** C5, C6
**Files:** `packages/gcp-components/policy/index.ts`, `packages/gcp-components/policy/rules/cloud-run.ts`,
`packages/gcp-components/test/policy/cloud-run.test.ts`, `.projenrc.ts`
**Scope:** M

---

### C8: docs/control-mapping.md and its completeness test
The mapping doc, plus the test that stops it drifting from the suite. A doc that has drifted is worse
than no doc, because it reads as proof.

**Acceptance criteria**
- [ ] One row per control CR-01…CR-09: control → source → component → test name → policy rule
- [ ] `Source` cites CIS **only** where verified against a named benchmark version and control
      number; Google Cloud Run guidance otherwise. **No control ID is inferred from subject matter**
- [ ] CR-04's CIS candidate is either verified and cited precisely, or replaced by the Google URL —
      it is not left as a vague CIS gesture

**Verification**
- [ ] A test parses `docs/control-mapping.md`, extracts CR-ids and test names, and asserts
      **zero rows without a passing test and zero control tests without a row** — bidirectional
- [ ] Deleting a row or renaming a test makes that test fail
- [ ] `npm test` passes at the root across both packages

**Dependencies:** C7
**Files:** `docs/control-mapping.md`, `packages/gcp-components/test/control-mapping.test.ts`
**Scope:** S

---

### ✅ Checkpoint: Module v1 Complete
- [ ] All nine controls: default, unit test, policy rule, mapping row — no gaps in any direction
- [ ] Whole suite runs offline with no GCP credentials
- [ ] `npx projen` idempotent; both packages build, test, lint from a clean clone
- [ ] **Decide what comes back next** — the deferred runway-cli tasks below, `SecureServiceAccount`
      and `SecureArtifactRepository` to complete the v1 module scope, or the real `pulumi preview`
      integration check that needs a sandbox GCP project
      ([SPEC.md OQ3](../SPEC.md#open-questions) is still unanswered)
- [ ] Human review

---
---

## Deferred: runway-cli prototype

Not dropped. These tasks were the active plan until the Cloud Run component took priority; their
rationale is preserved verbatim at
[tasks/runway-cli-prototype-plan.md](runway-cli-prototype-plan.md).

**One amendment is owed when they resume:** every path below assumes the package sits at the repo
root. After C1 it lives at `packages/runway-cli`, so file paths and commands in Tasks 2–5 need
updating. That is a C1 consequence, not a regression in those tasks.

### ✅ Task 1: Bootstrap the CLI package — DONE
A single projen-managed TypeScript package. Not a monorepo — there is only one module in scope.

**Acceptance criteria**
- [x] `.projenrc.ts` declares one `typescript.TypeScriptProject` with a `bin` entry
- [x] `packageManager: NodePackageManager.NPM` is set **explicitly** — projen falls back to
      `YARN_CLASSIC` with a deprecation warning when the option is omitted
      (`projen/lib/javascript/node-package.js:249-252`), so silence yields a `yarn.lock`
- [x] TypeScript 7.0.2 and vitest 4.1.11 resolve and run — **if projen cannot drive TS 7, stop and report rather than silently pinning TS 5.x**
      → **Reported and resolved by decision.** TS 7 is the native compiler and exposes no JS
      compiler API, which breaks ts-node and typescript-eslint. `tsc` and vitest are unaffected.
      Chosen: keep TS 7 and run `.projenrc.ts` via `TypeScriptRunner.nodejs()`. ESLint was dropped
      ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940))
      and is **superseded by oxlint in Task 1b** — waiting on typescript-eslint is no longer needed.
- [x] `.gitignore` covers `node_modules/`, `dist/`, and temp scaffold output

**Verification**
- [x] `npm install && npx projen && npm run build && npm test` passes from a clean clone.
      **Install comes first** — `npx projen` executes `.projenrc.ts`, which imports `projen`, so it
      cannot run before `node_modules` exists. No lint step at the time this task shipped —
      the linter arrives in Task 1b.
- [x] `npx projen` twice produces zero diff on the second run (`git diff --exit-code`)
- [x] `package-lock.json` is generated and no `yarn.lock` or `pnpm-lock.yaml` appears

**Dependencies:** None
**Files:** `.projenrc.ts`, `.gitignore` (+ projen-generated `package.json`, `tsconfig.json`)
**Scope:** S — carries the plan's only high risk

---

### ✅ Task 1b: Wire Oxlint into the platform package — DONE
Restores the lint gate that TypeScript 7 took away. Separate from Task 1 because Task 1 shipped
without a linter and is already committed — this is the follow-up that closes it.

**Acceptance criteria**
- [x] `.projenrc.ts` registers a `lint` task running `oxlint --type-aware --deny-warnings`, and a
      `lint:fix` variant with `--fix`; `eslint: false` stays (projen has no oxlint component)
- [x] `oxlint@1.80.0` and `oxlint-tsgolint@7.0.2001` are pinned devDeps
- [x] `--deny-warnings` is present, so a warning fails the build rather than printing a report
- [x] `.oxlintrc.json` is projen-generated, not hand-written — it is config, and the repo's rule is
      that projen owns config

**Verification**
- [x] `npm run lint` exits 0 on the current tree
- [x] Introducing an unused variable makes `npm run lint` exit non-zero, and removing it restores 0
      — proves the gate actually gates
- [x] A floating promise is caught, proving `--type-aware` is live and not silently syntax-only
- [x] `npm install && npx projen && npm run build && npm test && npm run lint` passes from a clean clone
- [x] `npx projen` twice still produces zero diff

**Dependencies:** Task 1
**Files:** `.projenrc.ts`, `.oxlintrc.json` (generated), `test/toolchain.test.ts` (assert the pins)
**Scope:** S

---

### Task 2: `RunwayServiceProject` — emit a repo that builds
The mechanism the prototype exists to prove. A custom projen project type that emits the minimum
buildable repository.

**Acceptance criteria**
- [ ] `RunwayServiceProject` subclasses `projen.typescript.TypeScriptProject` and is exported
- [ ] Emits `.projenrc.ts`, `src/index.ts` (health endpoint only), `test/index.test.ts` (one passing test), `README.md`
- [ ] Emits an oxlint setup matching the platform's — `eslint: false`, a `lint` task, pinned
      `oxlint`/`oxlint-tsgolint`, and a generated `.oxlintrc.json`. This is what lets the scaffold
      pin TS 7 and still honour the "build, test, lint" output its spec advertises.
- [ ] Generated `.projenrc.ts` resolves `@runway/cli` via `file:` link so the repo can regenerate itself
- [ ] No `TODO` markers, commented-out code, or placeholder scaffolding in emitted files

**Verification**
- [ ] Test scaffolds into a temp dir and runs `npm install && npx projen && npm run build && npm test && npm run lint` — all pass unmodified
- [ ] Test asserts the exact emitted file tree, no extra files
      — **amended by Task 4**, which adds `.github/workflows/build.yml` to the expected tree
- [ ] `grep -rE "TODO|FIXME" <scaffold>` returns nothing
- [ ] Temp dir cleaned up on both pass and fail

**Dependencies:** Task 1
**Files:** `src/templates/runway-service-project.ts`, `src/index.ts`, `test/runway-service-project.test.ts`
**Scope:** M

---

### Task 3: `runway new` entry point
Wire the project type to a command. Parsing and dispatch only — no scaffolding logic here.

**Acceptance criteria**
- [ ] `runway new <name>` scaffolds via `RunwayServiceProject` into `./<name>`
- [ ] Refuses a non-empty target directory and writes nothing
- [ ] Rejects invalid names, including path traversal, before writing anything
- [ ] `--help` lists the command and its arguments

**Verification**
- [ ] End-to-end test through the CLI binary, not the project type directly; scaffolded repo builds
- [ ] Non-empty-dir test asserts the pre-existing file is byte-identical afterwards
- [ ] Traversal fixture (`../escape`) exits non-zero and writes nothing

**Dependencies:** Task 2
**Files:** `src/cli.ts`, `src/commands/new.ts`, `test/cli.test.ts`
**Scope:** S

---

### ✅ Checkpoint: Scaffolding Proven
- [ ] `runway new demo` produces a repo that builds, tests, and lints unmodified
- [ ] Whole flow runs offline with no GCP credentials
- [ ] **Decide what the prototype proved** — whether the paved-road approach is worth building out,
      and if so, which archived plan phases come back first
- [ ] Human review

---

## Phase 2: Generated CI

The scaffolded repo verifies itself on every pull request instead of only on the developer's
machine. Decisions and risks: [Phase 2 in plan.md](runway-cli-prototype-plan.md#phase-2-generated-ci).

---

### Task 4: Emit the CI workflow from `RunwayServiceProject`
Turn on projen's GitHub integration and switch off everything projen would add beyond the build
workflow. One emitted file, running the generated repo's own `build` task — which in projen's
`TypeScriptProject` chains compile → test, and Task 1b's `lint` task joins them, so a single job covers all three.

**Acceptance criteria**
- [ ] `RunwayServiceProject` sets `github: true`, `release: false`, `depsUpgrade: false`,
      `pullRequestTemplate: false`, and `githubOptions: { mergify: false, pullRequestLint: false }`
- [ ] The emitted `.github/` tree is exactly `.github/workflows/build.yml` — no release, upgrade,
      PR-lint, mergify, or PR-template files
- [ ] `workflowNodeVersion` matches the project's `minNodeVersion` (Node 22 per
      [SPEC.md](../SPEC.md#tech-stack)); `workflowPackageCache: true` sets `cache: "npm"`
- [ ] Workflow triggers are `pull_request`, `push` to `main`, and `workflow_dispatch`
- [ ] The emitted job contains **no** package-manager setup action — under npm, projen adds no
      counterpart to the `pnpm/action-setup@v5` step it emits for PNPM
      (`projen/lib/javascript/node-project.js:623-628`)

**Verification**
- [ ] `npm test -- -t "ci workflow"` passes
- [ ] Build-out test (extending Task 2's): scaffold to a temp dir, then
      `npm install && npx projen && npm run build && npm run lint` still passes with the workflow present
- [ ] Test parses the emitted YAML and asserts job `build` exists with steps in order:
      checkout → node setup → install → `npx projen build` — exactly four steps
- [ ] Test asserts `.github/workflows/` contains exactly one entry
- [ ] `npx projen` twice in the scaffold produces zero diff on the second run

**Dependencies:** Task 2
**Files:** `src/templates/runway-service-project.ts`, `test/templates/ci-workflow.test.ts` (new),
`test/runway-service-project.test.ts` (file-tree assertion amended)
**Scope:** S — 3 files, one an amendment

---

### Task 5: Workflow contract — validation, secrets, and the self-mutation caveat
Make explicit the two things a green CI run hides: that the workflow bakes in no credentials, and
that self-mutation needs `PROJEN_GITHUB_TOKEN` and is skipped on fork PRs. Split from Task 4 so
these negative paths are proven rather than appended to a task that already "works".

**Acceptance criteria**
- [ ] Generated `README.md` documents the `PROJEN_GITHUB_TOKEN` repository secret: what it is for,
      what breaks without it, and that self-mutation is skipped on pull requests from forks
- [ ] No literal credential, project ID, region, or token appears anywhere in `.github/` — only
      `${{ secrets.* }}` references
- [ ] Stale projen output fails the build job — verified, not assumed

**Verification**
- [ ] `npm test -- -t "workflow contract"` passes
- [ ] `grep -rE "AIza|-----BEGIN|ghp_|github_pat_|projects/[0-9]+" <scaffold>/.github` returns nothing
- [ ] Test asserts every `secrets.` reference in the emitted YAML is in an allowlist of exactly
      `GITHUB_TOKEN` and `PROJEN_GITHUB_TOKEN` — a new secret cannot appear unnoticed
- [ ] Test asserts the `self-mutation` job carries both the not-a-fork condition and
      `permissions: contents: write`
- [ ] Test asserts the generated README mentions `PROJEN_GITHUB_TOKEN`, so a later template edit
      cannot silently drop the caveat
- [ ] Stale-output check: mutate a projen-managed file in the scaffold, run the build task, assert
      a non-zero exit

**Dependencies:** Task 4
**Files:** `src/files/readme.ts` (wherever Task 2 puts the README template),
`test/templates/workflow-contract.test.ts` (new)
**Scope:** S

---

### ✅ Checkpoint: Generated CI Complete
- [ ] `runway new demo` emits exactly one workflow, and it is the only file under `.github/`
- [ ] The scaffolded repo still builds, tests, and lints unmodified — CI added nothing to fix
- [ ] Whole flow runs offline: no GCP credentials, no network beyond the npm registry
- [ ] `npx projen` remains idempotent in the scaffold
- [ ] `PROJEN_GITHUB_TOKEN` is documented in the generated README, not just known here
- [ ] **Decide whether the deferred `pulumi preview` job returns with `gcp-components`, or whether
      the generated CI shape needs revisiting first** —
      [SPEC-runway-cli.md](../SPEC-runway-cli.md#boundaries) makes workflow shape an ask-first change
- [ ] Human review
