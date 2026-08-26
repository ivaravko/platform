# Tasks: environment-provisioning

Nine tasks, three checkpoints. Rationale, dependency graph and risks: [tasks/plan.md](plan.md).
Completed history: [tasks/completed-v1.md](completed-v1.md).

- **Phase E — The boundary** (E1–E5): the permission set, the audit that refuses, and
  `ServiceEnvironment` built twice — staging, then production.
- **Phase F — The command** (E6–E7): `runway bootstrap`, and proof against real GCP that a human
  with legitimate credentials cannot deploy to production.
- **Phase G — Close out** (E8–E9): the two dangling tasks from earlier plans, so nothing is left
  half-finished behind this module.

E2 and E3 are the only safely parallel pair — both depend on E1 alone and touch disjoint files.

---

## Phase E: The boundary

### E1: The deploy permission set
What counts as deploy-capable. EP-01, EP-02 and EP-06 all turn on this one answer, so getting it
wrong makes three controls wrong in the same direction — silently permissive.

**Acceptance criteria**
- [x] Deploy-capability is decided by **Cloud Run deploy permissions matched by verb**, per the
      spec's resolution — not by role name. A custom role granting `run.services.create` is
      deploy-capable however it is named
- [x] Predefined roles are resolved to their permissions, and the set is stated explicitly rather
      than inferred at runtime from an API that may be unavailable
- [x] Exported from the package's `src/index.ts`

**Verification**
- [x] Table-driven over: `roles/run.admin`, `roles/run.developer`, `roles/owner`, `roles/editor`,
      a custom role with `run.services.update`, and a genuinely harmless role
- [x] **Failure-injected**: a role that merely *contains* "run" but grants no deploy permission is
      not deploy-capable — the false-positive direction, which is how a control gets disabled
- [x] `npm test --workspace @runway/environment-provisioning -- -t "EP-"` passes, offline

**Dependencies:** None
**Files:** `packages/environment-provisioning/src/roles.ts`, `src/index.ts`, `test/roles.test.ts`,
`.projenrc.ts`
**Scope:** M — includes standing the package up

---

### E2: EP-06 — refuse a production project that already grants human deploys
A read-only audit over an existing IAM policy. **It refuses and never repairs**, per the spec's
resolved open question.

**Acceptance criteria**
- [x] Given an IAM policy, reports every binding granting a deploy-capable role to a **human**
      principal — `user:`, and `group:` where the group is not the CI identity
- [x] `serviceAccount:` principals are not human; the CI deployer is expected to hold this role
- [x] Refuses with the offending bindings named. **No `--fix`, no `--force`** — the spec is explicit
      that remediation is the team's, so the module never mutates what it is auditing
- [x] The message says what to remove and where, because a refusal a team cannot act on gets bypassed

**Verification**
- [x] Fixture-driven over policies containing: a user binding, a group binding, a service-account
      binding, a custom deploy-capable role, and a clean policy
- [x] **Failure-injected**: a clean policy passes, then one human binding is added and the same
      check fires — absence proven against injected presence, not asserted alone
- [x] Nothing in the module can write IAM: asserted structurally, not by review

**Dependencies:** E1
**Files:** `packages/environment-provisioning/src/audit.ts`, `test/audit.test.ts`,
`docs/control-mapping.md`
**Scope:** M

---

### E3: `ServiceEnvironment` — staging
The safe half first. One adopted project, its IAM, its state prefix.

**Acceptance criteria**
- [x] **EP-04**: staging deploy is granted to a **developers group**, never to an individual — a
      `user:` principal is rejected at construction
- [x] **EP-05**: the state bucket is versioned and access-controlled per environment; two
      environments never share one
- [x] Adopts an existing project — it does not create one, per the spec's resolved question
- [x] `ServiceEnvironment` is the unit. **No `isProduction` flag**, now or later: the caller composes
      it twice, because a branch is where the boundary silently softens

**Verification**
- [x] Assertions resolve `Output` values, never constructor arguments
- [x] **Failure-injected**: passing a `user:` principal throws; passing a group does not
- [x] A structural test asserts the args interface carries no environment-kind flag
- [x] `npm test -- -t "EP-0[45]"` passes offline

**Dependencies:** E1
**Files:** `packages/environment-provisioning/src/service-environment.ts`, `src/index.ts`,
`test/service-environment.test.ts`, `docs/control-mapping.md`
**Scope:** M

---

### E4: Workload Identity Federation
**EP-03**: CI authenticates by federation. One pool per service, in that service's own project, per
the spec's resolved question.

**Acceptance criteria**
- [x] Creates a per-service pool and provider; **no service account key is ever created**, and the
      component exposes no way to ask for one — the same guarantee as SA-01
- [x] The provider's attribute condition is scoped to **one repository and one ref**, not to the
      GitHub issuer at large
- [x] The binding names the CI deployer service account only

**Verification**
- [x] **Failure-injected, both axes**: the condition rejects a wrong repository *and* a wrong ref.
      Asserting that a condition string merely exists would pass for a condition matching everything
- [x] A policy rule rejects a raw `gcp.serviceaccount.Key` anywhere in a bootstrap stack, with a test
      proving it fires
- [x] `npm test -- -t "EP-03"` passes offline

**Dependencies:** E3
**Files:** `packages/environment-provisioning/src/workload-identity.ts`,
`test/workload-identity.test.ts`, `src/policy/*`, `docs/control-mapping.md`
**Scope:** M

---

### E5: `ServiceEnvironment` — production
Where the boundary actually exists. Composes E2's audit and E4's federation.

**Acceptance criteria**
- [x] **EP-01**: the production project grants **no deploy role to any human principal** — no user,
      no group, no exception, no justified opt-out. Unlike `publicAccess`, there is no form of this
      that is acceptable, so there is no form to supply
- [x] **EP-02**: the deploy role is granted **only** to the CI federated identity, scoped to one
      repository and ref
- [x] Construction runs E2's audit first and **refuses** if the adopted project already grants human
      deploys — bootstrap fails rather than proceeding onto a compromised project

**Verification**
- [x] **Failure-injected**: constructing against a policy containing a human deploy binding throws,
      and the same construction against a clean policy succeeds
- [x] The emitted IAM is enumerated and checked binding by binding, not counted — a count of one
      would pass for the wrong single binding
- [x] `npm test -- -t "EP-0[12]"` passes offline

**Dependencies:** E2, E4
**Files:** `packages/environment-provisioning/src/service-environment.ts`, its tests,
`docs/control-mapping.md`
**Scope:** M

---

### ✅ Checkpoint: the boundary exists in code
- [ ] All seven EP controls hold, each with a named test and a mapping row
- [ ] Every negative assertion is failure-injected — no absence asserted without injected presence
- [ ] The completeness test passes bidirectionally with `EP-` included
- [ ] **Answer [plan OQ2](plan.md#open-questions)** — whether `runway bootstrap` may write IAM, and
      to which projects — before E7 runs anything
- [ ] Human review

---

## Phase F: The command

### E6: `runway bootstrap`
Wires the module to a command. Parsing and composition only.

**Acceptance criteria**
- [x] `--staging-project` required; `--production-project` **optional**, because a service may adopt
      staging alone and add production later
- [x] **EP-07**: `--print-config` reports a service with no production environment as
      **incomplete** — visibly, not by omission, since a silent gap reads as "configured"
- [x] Refuses invalid project ids and repository specs before touching anything
- [x] `--help` lists the flags and says which are required

**Verification**
- [x] End-to-end through the CLI binary, not the module directly
- [x] **Failure-injected**: staging-only output states production is missing; a run with both does not
- [x] A dry run writes nothing — asserted by checking the target project is unchanged, per resource
      type, rather than inferred from an empty filter

**Dependencies:** E5
**Files:** `packages/runway-cli/src/commands/bootstrap.ts`, `src/cli.ts`, `test/commands/*`
**Scope:** M

---

### E7: Prove the boundary in GCP
The claim the module exists to make: **a developer holding every credential they legitimately
possess still cannot deploy to production.** Until this runs, that is a design, not a fact.

**Acceptance criteria**
- [x] EP-06's refusal demonstrated against a **real** project whose IAM grants a human deploy role
- [ ] ~~The staging path bootstraps successfully and the grants are read back from Google~~ —
      **descoped by OQ2 (preview-only)**: the staging composition was *previewed* against the real
      provider, creates-only, inputs asserted; no grant was written to read back
- [ ] ~~A human principal's deploy attempt against production is **denied by GCP**~~ — **descoped
      by OQ1/OQ2**: no clean production target and no write authorization; recorded as unverified
      in the spec's Verification status, not assumed

**Stop conditions**
- [x] **Gated on [plan OQ2](plan.md#open-questions).** This writes IAM to a real project. Do not run
      it on unstated authorization
- [x] If no project can serve as a clean production target ([plan OQ1](plan.md#open-questions)),
      **stop and report** — verify the refusal path and say plainly that the acceptance path is
      unverified. Do not weaken EP-06 to manufacture a passing test

**Verification**
- [x] Every grant made is recorded so it can be revoked — vacuously: zero grants were made, per
      OQ2
- [x] Project state checked per resource type before and after — the preview plan contained
      creates and nothing else, so nothing of ours pre-existed or was left
- [x] Result recorded in [SPEC-environment-provisioning.md](../SPEC-environment-provisioning.md),
      including anything left unverified — see its Verification status section

**Dependencies:** E6
**Files:** `test-integration/`, `SPEC-environment-provisioning.md`
**Scope:** M — carries the plan's highest risk

---

### ✅ Checkpoint: the boundary holds against Google
- [ ] EP-06 refuses a real project that grants human deploys
- [ ] Staging bootstraps, and its grants read back correctly from GCP
- [ ] Anything unverified is stated plainly rather than implied by silence
- [ ] Everything granted during the run has been revoked, and that is confirmed
- [ ] **Resolve [plan OQ3](plan.md#open-questions)** — `service-stacks`' three open questions —
      before its plan is written
- [ ] Human review

---

## Phase G: Close out

### E8: T11–T12 — the integration workflow
Left unchecked when the T-series landed. Folded in here so it is not carried indefinitely as
"nearly done".

**Acceptance criteria**
- [ ] **T11**: the remaining API(s) enabled on the sandbox, recorded per-API by exact match — an
      empty `grep` cannot distinguish "not enabled" from "the command failed", which has already
      produced one wrong claim in this repo
- [ ] **T12**: an `integration` workflow that runs the gated tier, separately from the PR gate
- [ ] **The PR gate stays credential-free and offline** — the integration tier never runs there

**Verification**
- [ ] The workflow is parsed and asserted structurally, as `ci-workflow.test.ts` already does
- [ ] No literal credential, project id or token appears anywhere in `.github/`
- [ ] Failure injection demonstrated at least once in the tier (T10 already does this)

**Dependencies:** None
**Files:** `.projenrc.ts`, `.github/workflows/`, `test/`, `tasks/integration-tests-plan.md`
**Scope:** S

---

### E9: D7 — publishing, now three packages
Carried from [v1-completion](v1-completion-plan.md). Still last, and now later still: this module
adds a third package, and publishing freezes all three.

**Acceptance criteria**
- [ ] All three packages publish independently with independent versions
- [ ] The registry decision is made and recorded — still open, and now open for three packages
- [ ] Generated repos resolve `@runway/gcp-components` by **published version**, replacing the
      `file:` link D5 chose
- [ ] The policy pack still loads from a consumer tree after publishing — D1's mechanism verified
      against the published artifact, not assumed to survive packaging

**Verification**
- [ ] `npm pack` for each package contains what it should and nothing it should not
- [ ] A scaffolded repo installing the **published** packages builds, tests, lints, and previews
- [ ] The published policy pack enforces: a raw non-compliant resource fails a real preview

**Dependencies:** E7
**Files:** `.projenrc.ts`, `.github/workflows/`, `packages/*/package.json`, `SPEC.md`
**Scope:** M

---

### ✅ Checkpoint: module complete
- [ ] A developer with every credential they legitimately hold cannot deploy to production, and that
      has been **observed against GCP** rather than designed
- [ ] All seven EP controls: default, test, mapping row, and failure injection
- [ ] Nothing outstanding from earlier plans — T-series and D-series both closed
- [ ] **Decide what `release-path` needs**, since it has no spec and is what makes this boundary
      usable ([plan OQ4](plan.md#open-questions))
- [ ] Human review
