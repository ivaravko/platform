# Tasks: v1 close-out

Seven tasks, three checkpoints. Rationale, dependency graph and risks: [tasks/plan.md](plan.md).
Specs: [SPEC-service-stacks.md](../SPEC-service-stacks.md) (`SS-01`–`SS-06`),
[SPEC-release-path.md](../SPEC-release-path.md) (`RP-01`–`RP-06`).
Completed history: [tasks/completed-v1.md](completed-v1.md). The environment-provisioning list this
pair replaces: [environment-provisioning-todo.md](environment-provisioning-todo.md), E1–E9 complete.

- **Phase P·offline** (P1–P3): the digest check, the coverage audit, the staging-public decision.
  No credential, no network, all in the PR gate.
- **Phase P·proof** (P4–P6): the production-project decision, then the verifications release-path
  recorded as skipped. Real GCP, gated, attended.
- **Phase P·close** (P7): the truth pass over the map, the README, and both specs.

P3 is the only safely parallel task — spec and docs only. P1 and P2 share the scaffold's test
files and are sequential. P5 and P6 are gated on P4 **and** explicit authorization.

---

## Phase P·offline

### P1: SS-02 — a tag on production fails a build, somewhere real
The control the spec marks Blocking and nothing implements. The program cannot enforce it — SS-01
forbids it from knowing which stack it is — so the check lives where the config lives: in the
generated repo.

**Acceptance criteria**
- [x] The scaffold emits a test (inside the generated repo's own suite) asserting
      `Pulumi.production.yaml` contains no `imageTag` and no image reference that is not
      digest-pinned (`sha256:`), with a message saying *why* — a tag can be repointed, and then
      production runs something no environment tested
- [x] `infra/index.ts` is untouched. **The program still never branches on stack name** — SS-01 and
      SS-02 are reconciled by placement, not by a conditional
- [x] The emitted check tolerates the legitimate states: no image key at all (pre-promotion — the
      honest state), and `imageDigest` written by CI
- [x] Criterion-7 line budget measured before and after; the emitted test counts as human-read

**Verification**
- [x] **Failure-injected, platform side**: the generation tier writes `imageTag: v2` into a
      scaffold's `Pulumi.production.yaml` and asserts the generated repo's own suite fails on it —
      the check proven to fire, not merely to exist
- [x] The build-out tier still passes end to end: a fresh scaffold with the check runs green,
      because its pristine production config is a legitimate state
- [x] `npm test --workspace @runway/cli -- -t "SS-02"` passes offline
- [x] Line-count delta stated in the PR

**Dependencies:** None
**Files:** `packages/runway-cli/src/templates/runway-service-project.ts`,
`packages/runway-cli/test/templates/runway-service-project.test.ts`
**Scope:** M

---

### P2: Every SS and RP control gets a named test, or a named reason
One of six SS ids appears in a test name today. The repo's rule — a control without a test is not a
control — applies to its own specs, not only to components.

**Acceptance criteria**
- [ ] Each of SS-01–SS-06 and RP-01–RP-06 either appears in a passing named test or is listed in
      its spec's verification status with the reason it cannot be offline-tested (runtime-only
      proofs belong to P5/P6, and say so)
- [ ] Existing assertions that already cover a control under another name are renamed to carry the
      id, not duplicated — SS-06's length/leading-digit rules in `new.test.ts` are the known case
- [ ] **Decided, ask-first: do SS/RP ids get `docs/control-mapping.md` rows?** The completeness
      test is bidirectional, so a row is a standing commitment. Either way the decision and its
      reason land in the spec
- [ ] The stale Corrections note in SPEC-service-stacks.md — the `?? "v1"` fallback it says is
      "deliberately left" — reconciled with the code, which now throws naming both keys

**Verification**
- [ ] `npm test --workspace @runway/cli -- -t "SS-"` and `-t "RP-"` each run a non-empty,
      passing set
- [ ] The control-mapping completeness test passes in whichever direction was decided
- [ ] `npm run build` green at the root

**Dependencies:** P1 (same test files)
**Files:** `packages/runway-cli/test/**`, `SPEC-service-stacks.md`, `SPEC-release-path.md`,
`docs/control-mapping.md` (decision-dependent)
**Scope:** M

---

### P3: May staging be public? Answer it where one program serves two stacks
Service-stacks OQ3, plus the sharper half the spec understates: `publicAccess` is an argument in
`infra/index.ts`, and that file runs for **both** stacks — so a per-stack opt-out must key on
configuration, or a team opening staging opens production with it.

**Acceptance criteria**
- [ ] The decision is made and recorded in SPEC-service-stacks.md: staging may opt out via the
      existing justified `publicAccess`, per stack, keyed on config — or it may not, with the
      reason
- [ ] If allowed: the spec shows the worked config-keyed example (the pattern, not a new emitted
      file — the scaffold stays minimal and private-by-default either way)
- [ ] The scaffold's default output is unchanged: nothing public, no new file, no new config key
      emitted

**Verification**
- [ ] If an example pattern is specified, a test proves the config-keyed opt-out on one stack
      leaves the other stack's plan private — failure-injected by applying the opt-out and
      asserting the *other* stack did not change
- [ ] `pulumi preview` assertions stay in the existing tiers; nothing new touches GCP

**Dependencies:** None — parallel with P1–P2
**Files:** `SPEC-service-stacks.md`, `packages/gcp-components/test/**` (only if the example lands)
**Scope:** S

---

### ✅ Checkpoint 1: the offline gaps are closed
- [ ] A tag injected into a production stack config demonstrably fails a build
- [ ] Twelve control ids: each named in a test or accounted for in a verification status
- [ ] OQ3 resolved in the spec; scaffold output unchanged
- [ ] Full gate green, offline, at the root
- [ ] Human review

---

## Phase P·proof

### P4: Revisit the two standing "no" decisions, or confirm the descope
Not an open question — two closed ones, both answered "no" on 2026-08-26 by the E-series:
**refusal-only** (its OQ1: no clean production target exists; EP-06 correctly refuses the
owner-held sandbox) and **preview-only** (its OQ2: `runway bootstrap` writes no IAM anywhere,
explicitly "until this decision is revisited"). This task is that revisit. P5 and P6 need **both**
reversed; either one standing keeps them descoped.

**Acceptance criteria**
- [ ] **The user decides, twice**: a clean production project is designated (named, with who
      created it and what they hold) **and** IAM-write authorization is granted, scoped to that
      project — or the descope is confirmed as v1's final answer
- [ ] The outcome lands in [environment-provisioning-plan.md OQ1/OQ2](environment-provisioning-plan.md#open-questions)
      and SPEC-release-path.md's verification status, cross-linked
- [ ] If the descope stands: P5 and P6 close as descoped with their unverified claims enumerated
      on the spec's front section, and Checkpoint 2 takes its fallback branch

**Verification**
- [ ] If designated: `runway bootstrap`'s EP-06 audit *accepts* the project — the acceptance path
      exercised for the first time — and `gcloud projects get-iam-policy` confirms no human deploy
      binding independently of our own code

**Dependencies:** None to decide; blocks P5, P6
**Files:** `tasks/environment-provisioning-plan.md`, `SPEC-release-path.md`
**Scope:** S — a decision, not code

---

### P5: Promote to production, observed
The verifications SPEC-release-path.md records as skipped, run for real: bootstrap production,
push a tag, watch CI resolve and deploy the digest.

**Acceptance criteria**
- [ ] `runway bootstrap` provisions the production environment: WIF, state bucket, CI deployer,
      the IAM the boundary requires — every grant recorded for revocation
- [ ] A pushed `v*` tag deploys production with the digest that tag resolves to; the resolution is
      in the run log (RP-02 at runtime); the service responds on its private ingress
- [ ] A tag absent from the registry fails the run before any `pulumi` step (RP-03 at runtime)
- [ ] Results recorded in SPEC-release-path.md's verification status, replacing "skipped" entries
      with observed verdicts — including anything that still failed

**Stop conditions**
- [ ] **Gated on P4 and on explicit authorization** — this writes IAM and deploys to a real
      project; SPEC.md's unattended-run prohibition applies in full
- [ ] Any state that cannot be cleanly reverted: stop, record, report — do not improvise

**Verification**
- [ ] Deployed state read back through the GCP API, never through Pulumi state, per the
      integration tier's standing rule
- [ ] The run is attended, per the spec's resolved OQ4 — whoever pushes the tag watches it

**Dependencies:** P4
**Files:** `test-integration/**`, `SPEC-release-path.md`
**Scope:** M — the plan's highest-risk task

---

### P6: The negative proofs — 403, no keys, rollback
The claims that make the boundary a fact. Each is an absence, so each is proven against injected
presence or direct observation, never asserted alone.

**Acceptance criteria**
- [ ] A developer holding their full legitimate credentials runs
      `pulumi up --stack production` and receives **403 — observed, not asserted** (RP success
      criterion 5; the E7 claim finally lands)
- [ ] `gcloud iam service-accounts keys list` over every SA in the production project returns zero
      user-managed keys (RP criterion 4), recorded per account rather than as an empty grep
- [ ] `gh workflow run release.yml --ref <old-tag>` redeploys that tag's digest with the
      dispatching actor in the run log; the same dispatch on `main` deploys nothing (RP-06 at
      runtime, both halves)
- [ ] Verdicts recorded in SPEC-release-path.md; anything still unverified stated plainly

**Verification**
- [ ] The 403 is captured from the actual command output, identity named
- [ ] The rollback's non-tag refusal is the failure-injected half — run it, watch it refuse
- [ ] Everything granted for this phase that should not persist is revoked, and the revocation
      confirmed by re-reading the IAM policy

**Dependencies:** P5
**Files:** `test-integration/**`, `SPEC-release-path.md`
**Scope:** M

---

### ✅ Checkpoint 2: the boundary is observed, or the gap is stated
- [ ] Tag → digest → production deploy: watched, logged, recorded
- [ ] The human 403, the zero-keys read, the rollback dispatch and its refusal: all observed
- [ ] **Or**, on the descope branch: SPEC-release-path.md's front section states exactly which
      claims are design rather than observation, and why
- [ ] Nothing granted during the phase remains that should not; confirmed by re-read
- [ ] Human review

---

## Phase P·close

### P7: The v1 truth pass
The map, the README, and the specs say the same thing, and none of them claims more than happened.

**Acceptance criteria**
- [ ] SPEC.md's capability map marks all five modules built; "Not built yet" in README.md contains
      only what is genuinely not built, with the production-verification verdict (whichever branch)
      stated there too
- [ ] The E-series checkpoint boxes left unticked in
      [environment-provisioning-todo.md](environment-provisioning-todo.md) are resolved with the
      user — reviewed and ticked, or their gaps folded into the open questions here
- [ ] Completed history appended to [completed-v1.md](completed-v1.md) per its format
- [ ] Every plan file in `tasks/` is closed, superseded, or active — none ambiguous

**Verification**
- [ ] `npm run build` green at the root, offline
- [ ] A cold read of README.md against `git log` finds no claim ahead of reality — the check that
      caught the stale `runway doctor` line last time, run deliberately this time

**Dependencies:** P1–P6 (or their recorded descope)
**Files:** `SPEC.md`, `README.md`, `tasks/**`
**Scope:** S

---

### ✅ Checkpoint 3: v1 closed
- [ ] All twelve SS/RP controls: enforced, tested, or plainly stated as unverified with the reason
- [ ] The paved road's central promise — a team's first commit is already correct, and no human can
      deploy to production — is either observed end to end or caveated on the front page
- [ ] Human review of the whole claim
