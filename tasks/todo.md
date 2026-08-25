# Tasks: gcp-components — SecureContainerService

Eight tasks, four checkpoints. Rationale, verified toolchain findings, and risks:
[tasks/plan.md](plan.md). Spec: [SPEC-secure-container-service.md](../SPEC-secure-container-service.md).

- **Phase A — Foundation** (C1–C2): npm workspaces, and proof that Pulumi works on TypeScript 7.
- **Phase B — Component** (C3–C6): the validator, the private default, the justified opt-out,
  Binary Authorization.
- **Phase C — Enforcement** (C7–C8): the policy pack for consumers who bypass the component, and a
  control-mapping doc that cannot drift from the suite.

Strictly sequential. C5 and C6 both depend on C4 but edit the same file, so they do not parallelise.

**runway-cli is a second, parallel stream** — see [Active (parallel stream): runway-cli](#active-parallel-stream-runway-cli)
at the bottom. Tasks 2–5 there were deferred and are now resumed; they touch a different package and
run concurrently with C3–C8, sharing only the root `.projenrc.ts`. Component tasks use a `C` prefix
so that stream's numbering stays valid.

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

### ✅ C4: SecureContainerService — private default path — DONE (gap closed by integration run)
The component itself, hardened defaults only. Carries **CR-01, CR-04, CR-05, CR-06, CR-07**.

**Acceptance criteria**
- [x] Three required args (`location`, `image`, `serviceAccountEmail`) produce: ingress
      `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, `defaultUriDisabled: true`,
      `deletionProtection: true`, no IAM member, no `description`, no `runway-public` label
- [x] `invokerIamDisabled` is **not exposed and never set** — it disables the IAM check on
      `run.routes.invoke`, a wider hole than `allUsers` and invisible in an IAM policy dump
- [x] `serviceAccountEmail` validates synchronously for a plain string and inside `.apply()` for an
      `Output`; the arg stays `pulumi.Input<string>` so C-future can accept `SecureServiceAccount.email`
      without a breaking change
- [x] `deletionProtection` opt-out is the discriminated justified form, matching the house convention
- [x] TSDoc on `uri` states that the private path disables default-URI resolution, and TSDoc on the
      class states a default-constructed service is **unreachable until a load balancer is added** —
      otherwise the first developer to hit it "fixes" it with `publicAccess`
- [x] `vpcAccess`, `encryptionKey`, and `iapEnabled` appear **nowhere** in the args interface

**Verification**
- [x] One named `it` per control, named after its control-mapping row
- [x] Assertions are on resolved `Output` values, never on constructor arguments
- [ ] ~~Both validation paths tested: plain string throws at construction; `Output` rejects on
      resolution~~ — **NOT MET. The failing-`Output` half is not unit-testable here.**
      An Output's value is unknown at construction, so the check runs inside `apply`, and a throw
      there is observable only as a rejected promise. `Output` exposes no rejection path in its
      public type, and its internal one spawns promise chains nothing can attach to: a bare
      `pulumi.output(x).apply(() => { throw })` leaks **two** unhandled rejections even when the
      caller catches the one promise it can reach. **vitest exits 1 on unhandled rejections**
      (measured), so such a test fails the suite while passing itself. The only lever is
      `dangerouslyIgnoreUnhandledErrors`, which would disable that protection for every test in the
      package — a real safety net traded for one assertion. Declined.
      **Covered instead:** the validator is exhaustively tested in `service-account-email.test.ts`
      (21 cases), and a passing test proves the component runs it inside `apply` on an `Output`
      input. The one untested link is that Pulumi fails a deployment when an input's `apply` throws
      — Pulumi's behaviour, not this component's. The rationale is recorded in the test file so it
      is not rediscovered as a missing test.
- [x] `npm test --workspace @runway/gcp-components` passes with no `GOOGLE_APPLICATION_CREDENTIALS`

**Dependencies:** C3
**Files:** `packages/gcp-components/src/container-service/secure-container-service.ts`,
`packages/gcp-components/src/index.ts`,
`packages/gcp-components/test/container-service/secure-container-service.test.ts`
**Scope:** M

---

**Findings worth carrying forward**
- **A decision for the checkpoint.** The failing-`Output` gap exists only because
  `serviceAccountEmail` is `pulumi.Input<string>`. Narrowing it to a plain `string` would make
  CR-04 fully synchronous, fully testable, and impossible to get wrong — at the cost of the
  migration path the component spec chose it for: passing `SecureServiceAccount.email` (an
  `Output`) later without a breaking change. Worth deciding deliberately rather than inheriting.
- **Pulumi mocks must supply provider-computed outputs.** With only `args.inputs`, anything the
  real provider derives — a Cloud Run service's `uri` — resolves to `undefined`, and an assertion
  like `toBeDefined()` fails while `toBeUndefined()` would have *passed for the wrong reason*.
  `test/setup.ts` now returns a mocked `uri` for `gcp:cloudrunv2/service:Service`.
- `TYPE_NAMESPACE` moved from `index.ts` to its own module. Components need it, `index.ts`
  re-exports the components, and importing it from the barrel would close that loop.

### ✅ Checkpoint: Private Default Works
- [ ] A service built from three args alone is private, protected, and running under a validated SA
- [ ] Every assertion resolves an `Output`; none inspect constructor input
- [ ] Suite runs offline, no credentials
- [ ] Human review

---

### ✅ C5: Public access path — the justified opt-out — DONE
The escape hatch, and the auditability that makes it acceptable. Carries **CR-02, CR-03, CR-08**.

**Acceptance criteria**
- [x] `publicAccess: { justification }` simultaneously sets ingress `INGRESS_TRAFFIC_ALL`,
      `defaultUriDisabled: false`, emits one `allUsers` `roles/run.invoker` binding, writes
      `description`, and sets `labels["runway-public"] = "true"`
- [x] An empty or whitespace-only justification is **rejected** — it satisfies the type and defeats
      the control
- [x] The justification reaches `description` **verbatim**; it is not written to a label, which GCP
      would reject (label values: lowercase alphanumerics, `-`, `_`, ≤63 chars)

**Verification**
- [x] Justification round-trips into `description` unmodified
- [x] `labels["runway-public"]` is a valid GCP label value
- [x] Public path emits exactly one `ServiceIamMember`; private path emits zero
- [x] Empty and whitespace-only justifications both throw
- [x] `npm test --workspace @runway/gcp-components -- -t "CR-0[238]"` passes

**Dependencies:** C4
**Files:** `packages/gcp-components/src/container-service/secure-container-service.ts`,
`packages/gcp-components/test/container-service/secure-container-service.test.ts`
**Scope:** S

---

**Findings worth carrying forward**
- **Two CR-03 tests were passing for the wrong reason.** Pulumi registers resources
  *asynchronously*, so reading the mock's resource registry straight after a constructor returns
  sees an empty list. "Emits exactly one binding" failed loudly and got fixed; **"emits no binding
  on the private path" passed while proving nothing** — it would have stayed green if the component
  had emitted an `allUsers` binding on every service. Both now resolve an Output first, and the
  negative test additionally asserts that *some* resource registered, so absence can never again be
  indistinguishable from "nothing has happened yet". This is the failure mode negative tests are
  most prone to and the least likely to be noticed.
- The invoker binding is assigned to a local and passed to `registerOutputs` rather than
  constructed as a bare `new`. Not style: oxlint's `no-new` is enabled everywhere except
  `.projenrc.ts`, so a discarded construction fails the lint gate.
- **[plan OQ2](plan.md#open-questions) is now concrete and still unanswered.** `runway-public` is
  both the greppable signal *and* the evidence C7's policy rule will key on. A consumer who removes
  the label with `gcloud` leaves a service that is still public but invisible to CR-03. Deciding
  this shapes C7's rule, and C7 is next after C6.

### ✅ C6: Binary Authorization — opt-in — DONE
Carries **CR-09**. Note the verified type has **no attestor field**: it is
`{ useDefault, policy, breakglassJustification }`, which closes
[SPEC.md OQ4](../SPEC.md#open-questions) on different terms than it was asked.

**Acceptance criteria**
- [x] `binaryAuthorization` accepts `{ useDefault: true }` or `{ policy }`, and is **absent by
      default** — `useDefault` fails every deployment in a project with no BinAuthz policy, which is
      not a default a library may impose
- [x] `breakglassJustification` is **not exposed through any public API** — it is the documented way
      to bypass the policy this control exists to apply
- [x] Omitting the arg emits no `binaryAuthorization` block at all, rather than an empty one

**Verification**
- [x] Test asserts the emitted block for each of the two accepted forms
- [x] Test asserts no `binaryAuthorization` key is emitted when the arg is omitted
- [x] A type-level or structural test asserts `breakglassJustification` is unreachable from `SecureContainerServiceArgs`
- [x] `npm test --workspace @runway/gcp-components -- -t "CR-09"` passes

**Dependencies:** C4
**Files:** `packages/gcp-components/src/container-service/secure-container-service.ts`,
`packages/gcp-components/test/container-service/secure-container-service.test.ts`
**Scope:** S

---

**Findings worth carrying forward**
- **Test files were not typechecked by anything.** `compile` only covers `src`, vitest transpiles
  without checking types, and nothing else looked — so this task's type-level acceptance criterion
  would have been **inert**, silently passing whatever it asserted. Each package (and the root,
  whose `compile` is reset to fan out) now runs `tsc --noEmit` over its test tree as part of `test`.
  Wiring it up immediately surfaced a bad `as Record<string, unknown>` cast that had been sitting in
  the C4 tests since they were written.
- **The `@ts-expect-error` assertion was mutation-tested.** Widening the args type to admit
  `breakglassJustification` makes `tsc` fail with `TS2578: Unused '@ts-expect-error' directive`.
  Without that check the directive would look like coverage while asserting nothing — the same
  class of silent-pass as the C5 negative test.
- **[SPEC.md Open Question 4](../SPEC.md#open-questions) is closed on different terms than it was
  asked.** It assumes Binary Authorization "requires an attestor"; the verified
  `ServiceBinaryAuthorization` type has no attestor field at all. The resource either selects the
  project default or names a policy by path, and attestors are configured on the policy out of
  band. The premise was wrong, not the answer.

### ✅ Checkpoint: Component Complete
- [ ] All nine CR-* controls hold, each with a named test
- [ ] Negative tests exist for every opt-out; no control has only a happy path
- [ ] `vpcAccess`, CMEK, and IAP are absent from the public surface
- [x] **[plan OQ2](plan.md#open-questions) resolved** — C7's rules key on intrinsic facts
      (`ingress: ALL`, `allUsers` invoker binding) with a `description` justification as evidence;
      `runway-public` is demoted to a filtering convenience and is not evidence
- [ ] Human review

---

## Phase C: Enforcement

### ✅ C7: CrossGuard policy pack — DONE (gap closed by integration run)
The layer that catches the bypass case: a consumer who declares a raw `gcp.*` resource and skips the
component entirely. Built with `PolicyPack` + `validateResourceOfType`, `enforcementLevel: "mandatory"`.

**Acceptance criteria**
- [x] Rules reject: ingress `INGRESS_TRAFFIC_ALL` with no justification in `description`;
      `invokerIamDisabled: true`; `template.serviceAccount` absent or not `*.iam.gserviceaccount.com`;
      an `allUsers`/`allAuthenticatedUsers` `roles/run.invoker` binding on a service with no
      justification in `description`; any `breakglassJustification`
- [x] **No rule keys on the `runway-public` label** ([plan OQ2](plan.md#open-questions), resolved).
      A label is a self-asserted claim: a raw `gcp.*` resource carrying a hand-written
      `runway-public: "true"` would buy a silent pass with no justification anywhere. Intrinsic
      facts cannot be stripped to evade a rule, because stripping them makes the service private.
- [x] A test proves the forged-label bypass is closed: a raw public service **with** the label but
      **without** a justification is still rejected
- [x] The absent-serviceAccount rule is present and tested — the API types that field
      `Input<string | undefined>`, so omitting it is legal and silently yields the default compute SA
- [x] The pack is **precompiled JS** and its `Pulumi.yaml` (or equivalent) sets
      `runtime.options.typescript: false` — ts-node cannot load under TS 7, so a `.ts` policy pack
      will not run at all ([plan finding 5](plan.md#toolchain-findings-verified-not-assumed))

**Acceptance criteria — stop conditions**
- [x] If policy rules cannot be unit-tested under vitest without booting a real stack, **stop and
      report**. Do not weaken a rule to make it testable.

**Verification**
- [x] Each rule has a test asserting it fires on the violating resource and stays silent on the
      compliant one
- [~] A stack using only `SecureContainerService` passes with zero violations — **offline for the
      four resource-scoped rules; the stack-scoped CR-03 rule cannot be checked this way.**
      `pulumi.runtime.setMocks` supplies no dependency graph, and a Cloud Run service's name is
      provider-generated rather than an input, so a mocked compliant stack has nothing to correlate
      a binding against. Running that rule over mocked output reports a violation on a perfectly
      compliant stack — a fiction, not a finding. Covered instead by explicit dependency fixtures,
      and end-to-end only by the integration tier ([SPEC.md OQ3](../SPEC.md#open-questions), the
      sandbox project, is still unanswered).
- [x] `npm test --workspace @runway/gcp-components -- -t "policy"` passes, offline

**Dependencies:** C5, C6
**Files:** `packages/gcp-components/policy/index.ts`, `packages/gcp-components/policy/rules/cloud-run.ts`,
`packages/gcp-components/test/policy/cloud-run.test.ts`, `.projenrc.ts`
**Scope:** M

---

**Findings worth carrying forward**
- **The stop condition did not trigger.** Rules are plain functions over plain props, so they test
  with a spy — no engine, no stack, no credentials. `PolicyPack` itself is built by a factory that
  tests never call, and the policy array is exported separately so the wiring stays assertable.
- **The offline compliance test earned its keep immediately: it caught a bug that would have made
  the policy pack unusable.** CR-03 originally correlated a binding to its service by `props.name`.
  Cloud Run service names are **provider-generated** — an output, not an input — so any stack that
  lets Pulumi auto-name has nothing to match on, and a fully compliant stack failed its own policy
  pack. Now resolved through the engine's dependency edges (`propertyDependencies.name`, then
  `dependencies`), falling back to name only for explicitly-named services, and **failing closed**
  when nothing links them — otherwise the rule would be evadable by simply not wiring the reference.
- **`@pulumi/policy@1.21.0` ships a broken type barrel.** `index.d.ts` re-exports
  `unknownCheckingProxy` and `UnknownValueError` from `./proxy`, whose `.d.ts` is literally
  `export {};` — the declarations were stripped, though `proxy.js` exports them at runtime.
  Importing the package root fails `tsc` with TS2305. Fixed by importing `@pulumi/policy/policy`
  directly. The obvious alternative, `skipLibCheck`, would have stopped checking `@pulumi/pulumi`
  and `@pulumi/gcp` declarations too — exactly what C2 verified. 1.21.0 is the latest, so there is
  no fixed release to wait for.
- `PUBLIC_ACCESS_PREFIX` now lives in its own module, imported by both the component that writes it
  and the rule that reads it. Two copies would not fail on drift — the guardrail would quietly stop
  recognising its own output. A contract test asserts the component's emitted description satisfies
  the rule.

### ✅ C8: docs/control-mapping.md and its completeness test — DONE
The mapping doc, plus the test that stops it drifting from the suite. A doc that has drifted is worse
than no doc, because it reads as proof.

**Acceptance criteria**
- [x] One row per control CR-01…CR-09: control → source → component → test name → policy rule
- [x] `Source` cites CIS **only** where verified against a named benchmark version and control
      number; Google Cloud Run guidance otherwise. **No control ID is inferred from subject matter**
- [x] CR-04's CIS candidate is either verified and cited precisely, or replaced by the Google URL —
      it is not left as a vague CIS gesture

**Verification**
- [x] A test parses `docs/control-mapping.md`, extracts CR-ids and test names, and asserts
      **zero rows without a passing test and zero control tests without a row** — bidirectional
- [x] Deleting a row or renaming a test makes that test fail
- [x] `npm test` passes at the root across both packages

**Dependencies:** C7
**Files:** `docs/control-mapping.md`, `packages/gcp-components/test/control-mapping.test.ts`
**Scope:** S

---

**Findings worth carrying forward**
- **The completeness check was, at first, incapable of failing — and only mutation testing found
  it.** The scanner walks every `*.test.ts` for quoted control ids, and `control-mapping.test.ts`
  itself listed `"CR-01" … "CR-09"` in its expected array. So it discovered its own literals and
  concluded every control was tested. Three of four mutations failed correctly; the fourth
  ("rename a test so its control id disappears") passed, which is what exposed it. Fixed by
  excluding the checker from its own scan and deriving the expected ids rather than restating them.
  **Had I only run the four checks and seen them pass, this would have shipped as proof.**
- **Four mutations now verified**: delete a row → fail; strip a control id from a test title →
  fail; point a row at a nonexistent policy rule → fail; add a CIS citation without a version and
  control number → fail.
- **v1 ships zero CIS citations, deliberately.** Every URL was checked (HTTP 200) before being
  written down. The CIS GCP Foundations Benchmark has no Cloud Run section, and its IAM section —
  the only plausible anchor, for CR-04 — has not been read against these rows. Citing it would be
  exactly the inference [the agreed rule](../SPEC-secure-container-service.md#4-control-mapping-cites-cis-only-where-cis-genuinely-covers-the-control)
  forbids. A test enforces that any future CIS mention carries both a version and a numbered control.
- **`lib` was under-declared as es2020 on a Node 22 repo.** `tsc` rejected `toSorted` and
  `replaceAll` — APIs that run fine and that oxlint actively asks for. Raised to es2023 across all
  three projects. Caught by the typecheck gate added in C6; vitest had been perfectly happy.

### ✅ Integration run — SPEC.md OQ3 resolved, C4 and C7 gaps closed

Not a planned task. Ran once `project-4da1a7fd-3681-4524-853` was designated for `pulumi preview`,
to close the two criteria C4 and C7 could not meet offline. **`preview` only — nothing was created,
and a local file backend was used so no state reached Pulumi Cloud.**

- [x] **C4's failing-`Output` path** fails a real preview with the component's own message, verbatim
      including the corrective action. Untestable under vitest; trivial here, because the engine
      handles the rejection that vitest counts as a fatal unhandled error.
- [x] **C7's stack-scoped CR-03 rule** works end to end. A compliant two-service stack passed with
      zero violations; a four-resource raw stack failed with four mandatory violations
      (`cr01-cr03`, `cr04`, `cr05`, `cr09`).
- [x] **The OQ2 redesign is proven in reality:** the raw public service carried a forged
      `runway-public: "true"` label and was rejected anyway. Under the original label-keyed rule it
      would have passed silently.
- [x] **`typescript: false` on the stack works** — six resources planned, no ts-node involved.

**Findings**
- **A claim written into SPEC.md during C2 was wrong, and is now corrected.** `typescript: false`
  does *not* make policy packs runnable. The policy-pack runner hardcodes ts-node
  (`cmd/run-policy-pack/index.js:110`) and never reads `PulumiPolicy.yaml`. **The pack cannot load
  from anywhere inside this monorepo**, because TypeScript 7 resolves from the root; installed into
  a tree without TypeScript it loads and enforces correctly. That makes distribution a correctness
  constraint and it is now recorded in both specs.
- The default-compute-SA hint fires correctly on the project's **real** identity
  (`966948097214-compute@…`), and a real user-managed account is accepted. An earlier check used a
  project *id* rather than a project *number*, which is not the real format — the positive rule
  rejected it anyway, on the generic branch. Exactly the intended design: the hint list is cosmetic,
  the positive rule is the boundary.
- The sandbox **is not empty** and its Cloud Run Admin API is **not enabled**. `preview` needs
  neither; `up` would need both considered.

---

### ✅ Checkpoint: Module v1 Complete
- [x] All nine controls: default, unit test, mapping row — no gaps in any direction, enforced
      bidirectionally by test. Five have policy rules; four are component-only, and the mapping
      doc says which and why
- [x] Whole suite runs offline with no GCP credentials — 145 tests
- [x] `npx projen` idempotent; both packages build, test, lint
- [ ] **Decide what comes back next** — the deferred runway-cli tasks below, `SecureServiceAccount`
      and `SecureArtifactRepository` to complete the v1 module scope, or the real `pulumi preview`
      integration check that needs a sandbox GCP project
      ([SPEC.md OQ3](../SPEC.md#open-questions) is still unanswered)
- [ ] Human review

---
---

## Active (parallel stream): runway-cli

**Resumed.** These were deferred while the Cloud Run component took priority; their original
rationale is preserved verbatim at
[tasks/runway-cli-prototype-plan.md](runway-cli-prototype-plan.md), and the refresh is in
[tasks/plan.md](plan.md#runway-cli-tasks-25-refreshed).

The amendment this section anticipated has now been applied: paths sit under `packages/runway-cli`,
and `--workspace @runway/cli` is correct again now that real workspaces exist.

**Runs in parallel with C3–C8** — different packages, different source trees. The one shared file is
the root `.projenrc.ts`, where every subproject is declared; sequence edits to it rather than
assuming they merge.

**Scope, decided deliberately:** no `infra/` in the scaffold, and CLI surface limited to `new` plus
generated CI. `SecureServiceAccount` and `SecureArtifactRepository` do not exist, so
[SPEC-runway-cli.md](../SPEC-runway-cli.md#success-criteria) criteria **2, 3, 6 and 7 stay unmet by
this stream**. That is a cut, not an oversight — revisit at the checkpoint.

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

### ✅ Task 2: `RunwayServiceProject` — emit a repo that builds — DONE
The mechanism the prototype exists to prove. A custom projen project type that emits the minimum
buildable repository.

**Acceptance criteria**
- [x] `RunwayServiceProject` subclasses `projen.typescript.TypeScriptProject` and is exported
- [x] Emits `.projenrc.ts`, `src/index.ts` (health endpoint only), `test/index.test.ts` (one passing
      test), `README.md`, `.oxlintrc.json` — and nothing else
- [x] Generated `.projenrc.ts` resolves `@runway/cli` via `file:` link so the repo can regenerate itself
- [x] No `TODO` markers, commented-out code, or placeholder scaffolding in emitted files
- [x] **The scaffold carries the TS 7 survival kit.** The generated repo is itself projen-managed
      and TypeScript 7, so it hits every wall the platform hit. Three of these are the difference
      between a scaffold that builds and one that cannot run its first command:
  - [x] `projenrcTsOptions: { runner: TypeScriptRunner.nodejs() }` — ts-node throws on TS 7
        (`ts.sys` undefined); without it `npx projen` **fails outright** in the generated repo
  - [x] `eslint: false` plus hand-wired oxlint `lint`/`lint:fix` tasks and pinned
        `oxlint`/`oxlint-tsgolint` — `typescript-eslint` cannot install alongside TS 7, so without
        this `npm install` fails ERESOLVE
  - [x] Its own `.oxlintrc.json` — oxlint finds config by walking up, and a scaffold generated
        outside this monorepo has nothing to walk up to
  - [x] `testTask.exec("vitest run", { receiveArgs: true })` — without `receiveArgs`, projen accepts
        `-- --coverage` and silently drops it, reporting success having ignored the flag
- [x] **No `.npmrc`.** With no `@pulumi/*` dependency the scaffold needs no `legacy-peer-deps`; that
      escape hatch is a platform-only cost and must not propagate to users' repos

**Verification**
- [x] Test scaffolds into a temp dir and runs
      `npm install && npx projen && npm run build && npm test && npm run lint` — all pass unmodified.
      **Install precedes projen**: `.projenrc.ts` imports `projen` and cannot run before
      `node_modules` exists
- [x] Test asserts the exact emitted file tree, no extra files
      — **amended by Task 4**, which adds `.github/workflows/build.yml` to the expected tree
- [x] `npx projen` twice inside the scaffold produces zero diff on the second run
- [x] `grep -rE "TODO|FIXME" <scaffold>` returns nothing
- [x] Generated line count is reported, excluding lockfiles and projen-generated config, against
      [criterion 7](../SPEC-runway-cli.md#success-criteria)'s 200-line budget. **If it exceeds 200,
      stop and revise the number deliberately rather than quietly raising it**
- [x] Temp dir cleaned up on both pass and fail

**Dependencies:** Task 1b
**Files:** `packages/runway-cli/src/templates/runway-service-project.ts`,
`packages/runway-cli/src/index.ts`, `packages/runway-cli/test/templates/runway-service-project.test.ts`
**Scope:** M

---

### ✅ Task 3: `runway new` entry point — DONE
Wire the project type to a command. Parsing and dispatch only — no scaffolding logic here.

**Acceptance criteria**
- [x] `runway new <name>` scaffolds via `RunwayServiceProject` into `./<name>`
- [x] Refuses a non-empty target directory and writes nothing
- [x] Rejects invalid names, including path traversal, before writing anything
- [x] `--help` lists the command and its arguments

**Verification**
- [x] End-to-end test through the CLI binary, not the project type directly; scaffolded repo builds
- [x] Non-empty-dir test asserts the pre-existing file is byte-identical afterwards
- [x] Traversal fixture (`../escape`) exits non-zero and writes nothing

**Dependencies:** Task 2
**Files:** `packages/runway-cli/src/cli.ts`, `packages/runway-cli/src/commands/new.ts`,
`packages/runway-cli/test/cli.test.ts`
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

### ✅ Task 4: Emit the CI workflow from `RunwayServiceProject` — DONE
Turn on projen's GitHub integration and switch off everything projen would add beyond the build
workflow. One emitted file, running the generated repo's own `build` task — which in projen's
`TypeScriptProject` chains compile → test, and Task 1b's `lint` task joins them, so a single job covers all three.

**Acceptance criteria**
- [x] `RunwayServiceProject` sets `github: true`, `release: false`, `depsUpgrade: false`,
      `pullRequestTemplate: false`, and `githubOptions: { mergify: false, pullRequestLint: false }`
- [x] The emitted `.github/` tree is exactly `.github/workflows/build.yml` — no release, upgrade,
      PR-lint, mergify, or PR-template files
- [x] `workflowNodeVersion` matches `minNodeVersion` exactly — `22.18.0`, the `NODE_VERSION`
      constant in the root `.projenrc.ts`; `workflowPackageCache: true` sets `cache: "npm"`
- [x] Workflow triggers are `pull_request`, `push` to `main`, and `workflow_dispatch`
- [x] The emitted job contains **no** package-manager setup action — under npm, projen adds no
      counterpart to the `pnpm/action-setup@v5` step it emits for PNPM
      (`projen/lib/javascript/node-project.js:623-628`)

**Verification**
- [x] `npm test --workspace @runway/cli -- -t "ci workflow"` passes
- [x] Build-out test (extending Task 2's): scaffold to a temp dir, then
      `npm install && npx projen && npm run build && npm run lint` still passes with the workflow present
- [x] Test parses the emitted YAML and asserts job `build` exists with steps in order:
      checkout → node setup → install → `npx projen build`.
      **Criterion corrected: not "exactly four steps".** Keeping projen's self-mutation
      default (decided earlier) adds three more to the same job — diff the tree, upload the
      patch, fail on drift. The order and the absence of a package-manager setup step are what
      the criterion was protecting, and both hold.
- [x] Test asserts `.github/workflows/` contains exactly one entry
- [x] `npx projen` twice in the scaffold produces zero diff on the second run

**Dependencies:** Task 2
**Files:** `packages/runway-cli/src/templates/runway-service-project.ts`,
`packages/runway-cli/test/templates/ci-workflow.test.ts` (new),
`packages/runway-cli/test/templates/runway-service-project.test.ts` (file-tree assertion amended)
**Scope:** S — 3 files, one an amendment

---

### ✅ Task 5: Workflow contract — validation, secrets, and the self-mutation caveat — DONE
Make explicit the two things a green CI run hides: that the workflow bakes in no credentials, and
that self-mutation needs `PROJEN_GITHUB_TOKEN` and is skipped on fork PRs. Split from Task 4 so
these negative paths are proven rather than appended to a task that already "works".

**Acceptance criteria**
- [x] Generated `README.md` documents the `PROJEN_GITHUB_TOKEN` repository secret: what it is for,
      what breaks without it, and that self-mutation is skipped on pull requests from forks
- [x] No literal credential, project ID, region, or token appears anywhere in `.github/` — only
      `${{ secrets.* }}` references
- [x] Stale projen output fails the build job — verified, not assumed

**Verification**
- [x] `npm test --workspace @runway/cli -- -t "workflow contract"` passes
- [x] `grep -rE "AIza|-----BEGIN|ghp_|github_pat_|projects/[0-9]+" <scaffold>/.github` returns nothing
- [x] Test asserts every `secrets.` reference in the emitted YAML is in an allowlist.
      **Criterion tightened: the allowlist is one entry, not two.** The build job runs on the
      implicit default token and never names it, so `PROJEN_GITHUB_TOKEN` is the sole explicit
      reference. Asserting two would have permitted a secret that is not actually used.
- [x] Test asserts the `self-mutation` job carries both the not-a-fork condition and
      `permissions: contents: write`
- [x] Test asserts the generated README mentions `PROJEN_GITHUB_TOKEN`, so a later template edit
      cannot silently drop the caveat
- [x] Stale-output check: mutate a projen-managed file in the scaffold, run the build task, assert
      a non-zero exit

**Dependencies:** Task 4
**Files:** `packages/runway-cli/src/files/readme.ts` (wherever Task 2 puts the README template),
`packages/runway-cli/test/templates/workflow-contract.test.ts` (new)
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
