# Tasks: v1 completion

Seven tasks, three checkpoints. Rationale, risks and the finding that sets the order:
[tasks/plan.md](plan.md). Completed history: [tasks/completed-v1.md](completed-v1.md).

- **Phase D — Unblock and complete the components** (D1–D4): make the policy pack runnable where it
  is consumed, then finish the v1 component set and tighten the argument that has been carrying
  debt since C4.
- **Phase E — The paved road deploys** (D5–D6): the scaffold emits real infrastructure, and the
  repo it emits plans correctly against GCP. This is [success criterion 3](../SPEC.md#success-criteria).
- **Phase F — Distribution** (D7): publishing, last, because it freezes the API.

D2 and D3 are independent and touch disjoint files — the only safe parallel pair.

---

## Phase D: Unblock and complete the components

### ✅ D1: Make the policy pack runnable where it is actually consumed — DONE
The third enforcement layer is currently decorative for every scaffolded repo. `RunwayServiceProject`
pins `typescript@7.0.2`, and C7 proved the pack cannot load from a tree where `typescript` resolves.

**Acceptance criteria**
- [x] A repo produced by `runway new` can run `pulumi preview --policy-pack <pack>` and the pack
      **loads and enforces** — demonstrated, not argued
- [x] The chosen mechanism is documented in [SPEC-secure-container-service.md](../SPEC-secure-container-service.md#hardening-controls),
      replacing the current "must be consumed from a tree where `typescript` does not resolve" note
      with whatever is actually true afterwards
- [x] A test asserts the property the mechanism depends on, so a future change cannot silently
      break it — the pack failing to load is invisible until someone audits a stack

**Stop conditions**
- [x] If packaging cannot solve it, **stop and report.** The remaining lever is the generated repo's
      TypeScript version ([plan OQ2](plan.md#open-questions)), which is a decision to surface, not
      to take silently.
- [x] Do not weaken or drop a rule to make the pack loadable.

**Verification**
- [x] Scaffold a repo to a temp dir, run `pulumi preview --policy-pack` against it, confirm the pack
      appears in the `Policies:` block
- [x] A deliberately non-compliant resource in that scaffolded repo fails the preview
- [x] Root suite green; no GCP credentials needed for the unit-level part

**Dependencies:** None
**Files:** `packages/gcp-components/policy/*`, `.projenrc.ts`, `SPEC-secure-container-service.md`,
a new test asserting the mechanism
**Scope:** M — carries the phase's only high risk

---

**Findings worth carrying forward**
- **C7's statement of the constraint was wrong, and wrong in a misleading direction.** It said the
  pack must live where `typescript` does not resolve. That held only by accident of location. The
  real rule: **the nearest resolvable `typescript` must have a compiler API.** An isolated directory
  *inside* a TS 7 repo fails with no TypeScript in it and succeeds with TypeScript 5 in it — both
  measured. Corrected in both specs.
- **`--install-links` is load-bearing.** Without it npm *symlinks* a local package and Node resolves
  through the real path, putting the pack back inside the monorepo where TS 7 resolves. This failed
  identically to having no isolation at all, and only showed up because the pack and the consumer
  were finally in *different* trees — the earlier scratch test had them in one, which could not
  distinguish the two hypotheses.
- **Installing inside `node_modules/` does not survive `npm ci`** — measured, wiped. Hence
  `.runway-policy/`.
- All four properties are asserted by test and **mutation-tested**: aligning the two TypeScript
  pins, dropping `--install-links`, and moving the install into `node_modules` each fail the suite.

### ✅ D2: `SecureServiceAccount` — DONE
The second v1 component. Its absence is why C4 shipped a runtime check where the module spec
promised a compile-time one.

**Acceptance criteria**
- [x] Wraps `gcp.serviceaccount.Account`; exposes `.email` as `pulumi.Output<string>`
- [x] **`gcp.serviceaccount.Key` is unreachable through the public API** — no argument, no method,
      no escape hatch. Workload Identity only
- [x] Role validation rejects `roles/owner`, `roles/editor` and any `*Admin` role at construction,
      with a message naming the corrective action
- [x] Exported from `src/index.ts`; consumers never deep-import
- [x] Control-mapping rows, named tests and policy rules land in the same commit

**Verification**
- [x] Table-driven rejection over `roles/owner`, `roles/editor`, `roles/iam.serviceAccountAdmin`
      and at least one non-obvious `*Admin`
- [x] A policy rule rejects a raw `gcp.serviceaccount.Key` anywhere in a stack, with a test proving
      it fires — the bypass case is the whole reason the rule exists
- [x] Mutation-tested: break each new negative test and confirm it fails
- [x] `npm test --workspace @runway/gcp-components -- -t "SA-"` passes

**Dependencies:** D1 (ordering only — the policy rule should land on a runnable pack)
**Files:** `packages/gcp-components/src/service-account/*`, `src/index.ts`,
`src/policy/*`, `test/service-account/*`, `docs/control-mapping.md`
**Scope:** M

---

**Findings worth carrying forward**
- **D1's `policy:install` silently served a stale pack, and D2 is how that surfaced.** npm skips
  re-copying a package it already has at the same version, and this package's version never changes.
  The rebuilt pack carrying SA-01 and SA-03 never propagated — and the preview went **green**, which
  is indistinguishable from those rules passing. Only counting the registered policies exposed it.
  Fixed with `rm -rf` before install, asserted by test. This is the fourth silent-pass in this repo
  and the first that would have shipped a guardrail claiming to enforce rules it had never loaded.
- **The allowlist is empty and the denial set is the boundary**, per the decision. `roles/owner`,
  `roles/editor`, and anything whose **final segment ends in** `admin`. Final-segment matching, not
  substring: `roles/storage.admin` is administrative and a hypothetical `roles/cloudsql.admin.viewer`
  is not — rejecting things that are fine is how a control gets switched off.
- **`roles` is a plain array, not an `Input`** — deliberately, and it is the direct lesson from C4.
  The roles a service may hold are decided when the code is written, not discovered at deploy time,
  so validation stays synchronous and fully testable. C4's untestable path does not recur here.
- The policy rule calls `assertGrantableRoles` rather than reimplementing it, and a test asserts the
  rejection message originates there — two copies of one control would drift silently.
- The C8 completeness test was generalised from `CR-\d{2}` to `[A-Z]{2}-\d{2}` with contiguity
  checked per prefix, so a second component need not continue the first's numbering. Re-mutation-tested.
- Verified live: a raw `serviceaccount.Key` and a raw `roles/editor` grant both fail a real
  `pulumi preview`, and a compliant stack passes.

### ✅ D3: `SecureArtifactRepository` — DONE
The third v1 component. Independent of D2 — disjoint files, safe to run in parallel.

**Acceptance criteria**
- [x] `format: "DOCKER"`, standard mode, `dockerConfig.immutableTags: true` — a pushed tag can
      never be repointed
- [x] `vulnerabilityScanningConfig.enablementConfig: "INHERITED"`
- [x] `cleanupPolicies`: keep N most recent, delete untagged older than 30 days
- [x] `kmsKeyName` optional — CMEK supported, not required, no KMS component until v2
- [x] Arg surface **re-verified against the installed `@pulumi/gcp`**, not taken from the module
      spec: three of its claims about Cloud Run did not survive that check in C4/C5/C6
- [x] Control-mapping rows, named tests and policy rules in the same commit

**Verification**
- [x] Assertions resolve `Output` values, never constructor arguments
- [x] A policy rule rejects a raw repository without `immutableTags`, with a test proving it fires
- [x] Mutation-tested negative tests
- [x] `npm test --workspace @runway/gcp-components -- -t "AR-"` passes

**Dependencies:** D1 (ordering only)
**Files:** `packages/gcp-components/src/artifact-registry/*`, `src/index.ts`, `src/policy/*`,
`test/artifact-registry/*`, `docs/control-mapping.md`
**Scope:** M

---

**Findings worth carrying forward**
- **The arg surface held this time.** Re-verified against `@pulumi/gcp@9.35.1` as the task required:
  `dockerConfig.immutableTags`, `vulnerabilityScanningConfig.enablementConfig` (`INHERITED` |
  `DISABLED`), and the cleanup-policy shape all match the module spec. One correction: `mode` is
  `STANDARD_REPOSITORY`, not "standard".
- **`cleanupPolicyDryRun` is the interesting find, and it was not in the spec.** It evaluates every
  cleanup policy and deletes nothing — a repository looks correctly configured and retains
  everything. That is worse than having no policy, because the configuration reads as a control.
  AR-03 therefore asserts two things (policies set, dry-run off) and has its own policy rule.
- **AR-01 has no opt-out at all**, deliberately unlike `publicAccess`. A mutable tag means an
  approved reference stops meaning an approved image; there is no justification that makes that
  acceptable, so there is no justified form to supply.
- The AR-01 rule checks `format === "DOCKER"` first. `dockerConfig` is meaningless on a Maven or npm
  repository, and a rule that fires where it cannot apply is a rule that gets switched off.
- **A mutation test failed to fail, and the mutation was wrong rather than the test.** Stripping
  `AR-02` from one test file still passed, because the id also appears in the policy test — the
  control genuinely was still covered. Removing it from both files failed correctly. A mutation that
  does not actually remove the property proves nothing about the check.
- Verified live: a raw repository with mutable tags, scanning disabled and dry-run retention fails a
  real `pulumi preview` with all three AR violations. Ten policies now registered.

### ✅ D4: `SecureContainerService` takes a `SecureServiceAccount` — DONE
Closes [spec OQ1](../SPEC-secure-container-service.md#open-questions) and C4's documented gap. A
breaking change, taken deliberately while it is still free.

**Acceptance criteria**
- [x] `serviceAccountEmail: pulumi.Input<string>` becomes `serviceAccount: SecureServiceAccount`,
      making the default compute identity **unreachable through the type system** — the guarantee
      the module spec promised and v1 downgraded
- [x] C4's untestable failing-`Output` path is **gone, not worked around**: with no string argument
      there is no `apply`-time validation left to test, and the note in
      `secure-container-service.test.ts` explaining the gap is removed rather than left stale
- [x] CR-04's policy rule is unchanged — raw resources still bypass the type system, so the runtime
      check stays where it still matters
- [x] [SPEC-secure-container-service.md](../SPEC-secure-container-service.md) updated: scope
      decision 1 currently records the string form as a deliberate reduction, and that stops being
      true

**Verification**
- [x] A type-level test (`@ts-expect-error`) proves a bare string is rejected — **mutation-tested**,
      since an unused directive is exactly the silent-pass C6 caught
- [x] Every existing CR-01/04/05/06/07 test still passes, adjusted only for the new argument
- [x] Root suite green; `npx projen` idempotent

**Dependencies:** D2
**Files:** `packages/gcp-components/src/container-service/secure-container-service.ts`,
its tests, `SPEC-secure-container-service.md`
**Scope:** M

---

**Findings worth carrying forward**
- **C4's gap is gone rather than documented.** With no string argument there is no `apply`-time
  validation left, so the path vitest could not test does not exist. That is the difference between
  closing a gap and working around one — and it is why the plan put D4 before publishing.
- The `@ts-expect-error` assertion is **mutation-tested**: widening the argument back to
  `SecureServiceAccount | string` makes `tsc` fail with an unused directive. Without that check it
  would look like coverage while asserting nothing, which is the same silent-pass C6 caught.
- **The runtime check stayed where it still matters.** `assertUserManagedServiceAccount` is
  unchanged and still backs CR-04's policy rule: a consumer writing a raw `gcp.cloudrunv2.Service`
  bypasses the type system entirely. The type guards this component, the policy pack guards the rest
  — deleting the validator because "the type handles it now" would have removed the half that covers
  everyone who never uses the component.
- The C6 typecheck gate earned its keep again: the mechanical swap left four unused symbols that
  vitest was perfectly happy with and `tsc --noEmit` rejected.

### ✅ Checkpoint: v1 component set complete
- [ ] All three v1 components exist, exported, each with controls, tests, policy rules and mapping rows
- [ ] The C8 completeness test passes in both directions with the new controls included
- [ ] The policy pack loads and enforces in a scaffolded repo (D1), or the blocker is on the table
      with a decision requested
- [ ] **Decide [plan OQ1](plan.md#open-questions)** — the role allowlist's contents
- [ ] Human review

---

## Phase E: The paved road deploys

### D5: The scaffold emits `infra/` built from the components
The prototype deliberately emitted no infrastructure, because doing so early meant either raw
`gcp.*` resources or waiting on components. The components now exist.

**Acceptance criteria**
- [ ] `runway new <name>` emits an `infra/` Pulumi program using `SecureArtifactRepository`,
      `SecureServiceAccount` and `SecureContainerService` — and **no raw `gcp.*` resource**
- [ ] The emitted program is precompiled with `runtime.options.typescript: false`; ts-node cannot
      load under TS 7 and a `.ts` program would not run at all
- [ ] `@runway/gcp-components` is resolved by the generated repo, by version or `file:` link, and
      which one is a deliberate choice recorded in the template
- [ ] The emitted file tree is asserted exactly, as Tasks 2 and 4 already do
- [ ] No `TODO` markers, commented-out code, or placeholder scaffolding

**Verification**
- [ ] Build-out test: scaffold to a temp dir, `npm install && npx projen && npm run build && npm test && npm run lint` all pass unmodified
- [ ] `grep -rE "gcp\.(cloudrunv2|serviceaccount|artifactregistry)" <scaffold>/infra` returns nothing —
      the scaffold must not teach the habit the product exists to prevent
- [ ] Temp dir cleaned up on both pass and fail

**Dependencies:** D2, D3, D4
**Files:** `packages/runway-cli/src/templates/runway-service-project.ts`, its tests
**Scope:** M

---

### D6: The generated repo's `pulumi preview` succeeds — success criterion 3
The premise, finally testable: the repo `runway new` emits actually deploys.

**Acceptance criteria**
- [ ] `pulumi preview` on a freshly scaffolded repo, against `enduring-badge-506610-u9`, plans
      exactly one Artifact Registry repository, one service account, one Cloud Run service — and
      **nothing public** ([confirm the shape first](plan.md#open-questions), OQ5)
- [ ] The same preview run with `--policy-pack` reports **zero violations**
- [ ] `preview` only. `pulumi up` from a generated repo is a separate decision and is not taken here
- [ ] SPEC.md success criterion 3 marked met, with the evidence recorded

**Verification**
- [ ] Preview output captured and checked resource by resource, not just by count
- [ ] A deliberately weakened copy of the generated program fails the policy pack — proving the
      zero-violation result means the rules ran, not that they were absent
- [ ] Nothing is created: service-account and Cloud Run listings in the sandbox are unchanged
      afterwards, checked per-resource rather than inferred from an empty filter

**Dependencies:** D5, D1
**Files:** integration harness (location to be decided in D6), `SPEC.md`
**Scope:** M

---

### ✅ Checkpoint: the paved road works end to end
- [ ] A developer with no GCP knowledge can run `runway new`, and the result plans a private,
      least-privilege service against a real project
- [ ] The generated repo enforces its own guardrails — the policy pack loads and passes
- [ ] Success criteria 1–5 all met
- [ ] **Decide whether `pulumi preview` belongs in *generated* CI**, which needs Workload Identity
      and is the point where the PR gate stops being credential-free
- [ ] Human review

---

## Phase F: Distribution

### D7: Publishing with independent semver tags — success criterion 6
Last deliberately: publishing freezes the public API, and D4 is a breaking change.

**Acceptance criteria**
- [ ] Both packages publish independently, with independent versions
- [ ] The registry decision is made and recorded ([plan OQ3](plan.md#open-questions)) — it changes
      CI publish config and the generated repo's `.npmrc`
- [ ] The generated repo resolves `@runway/gcp-components` by **published version**, replacing
      whatever D5 chose
- [ ] The policy pack ships in the published artifact and still loads from a consumer tree (D1's
      mechanism holds after publishing, verified rather than assumed)

**Verification**
- [ ] `npm pack` for each package contains what it should and nothing it should not
- [ ] A scaffolded repo installing the **published** package builds, tests, lints, and previews
- [ ] `.npmrc` in the generated repo matches the registry decision

**Dependencies:** D6
**Files:** `.projenrc.ts`, `.github/workflows/*`, `packages/*/package.json`, `SPEC.md`
**Scope:** M

---

### ✅ Checkpoint: v1 complete
- [ ] All six SPEC.md success criteria met, each with recorded evidence
- [ ] Every control has a default, a test, a policy rule and a mapping row — enforced bidirectionally
- [ ] **Apply or reject the two upstream spec corrections** owed since C5/C6
      ([plan OQ4](plan.md#open-questions))
- [ ] Decide what v2 opens with: the deferred networking module, KMS, or widening into the CIS-covered
      services where the mapping doc's `Source` column finally has something to cite
- [ ] Human review
