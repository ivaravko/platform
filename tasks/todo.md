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
- [x] Each of SS-01–SS-06 and RP-01–RP-06 either appears in a passing named test or is listed in
      its spec's verification status with the reason it cannot be offline-tested (runtime-only
      proofs belong to P5/P6, and say so)
- [x] Existing assertions that already cover a control under another name are renamed to carry the
      id, not duplicated — SS-06's length/leading-digit rules in `new.test.ts` are the known case
- [x] **Decided, ask-first: do SS/RP ids get `docs/control-mapping.md` rows?** The completeness
      test is bidirectional, so a row is a standing commitment. Either way the decision and its
      reason land in the spec
- [x] The stale Corrections note in SPEC-service-stacks.md — the `?? "v1"` fallback it says is
      "deliberately left" — reconciled with the code, which now throws naming both keys

**Verification**
- [x] `npm test --workspace @runway/cli -- -t "SS-"` and `-t "RP-"` each run a non-empty,
      passing set
- [x] The control-mapping completeness test passes in whichever direction was decided
- [x] `npm run build` green at the root

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
- [x] The decision is made and recorded in SPEC-service-stacks.md: staging may opt out via the
      existing justified `publicAccess`, per stack, keyed on config — or it may not, with the
      reason
- [x] If allowed: the spec shows the worked config-keyed example (the pattern, not a new emitted
      file — the scaffold stays minimal and private-by-default either way)
- [x] The scaffold's default output is unchanged: nothing public, no new file, no new config key
      emitted

**Verification**
- [~] If an example pattern is specified, a test proves the config-keyed opt-out on one stack
      leaves the other stack's plan private. **Satisfied by reference, not new code**: CR-03's
      existing pair is exactly this — one construction with the opt-out plans one `allUsers`
      binding, one without plans none. A new test would only re-prove Pulumi's per-stack config
      isolation, and a weaker copy beside CR-03 would get cited as coverage. The spec resolution
      names the pair
- [x] `pulumi preview` assertions stay in the existing tiers; nothing new touches GCP

**Dependencies:** None — parallel with P1–P2
**Files:** `SPEC-service-stacks.md`, `packages/gcp-components/test/**` (only if the example lands)
**Scope:** S

---

### ✅ Checkpoint 1: the offline gaps are closed
- [x] A tag injected into a production stack config demonstrably fails a build
- [x] Twelve control ids: each named in a test or accounted for in a verification status
- [x] OQ3 resolved in the spec; scaffold output unchanged
- [x] Full gate green, offline, at the root
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
- [x] **The user decides, twice**: both reversed, 2026-08-26. `first01-production` created under
      `ihar-org` (by ihar@, whose creator `owner` was replaced with `serviceAccountAdmin` +
      `workloadIdentityPoolAdmin` + `storage.admin` + `projectIamAdmin` — no `run.*` verb among
      them, org-level `organizationAdmin` as the recovery path). IAM writes authorized, scoped to
      the two first01 projects
- [x] The outcome lands in [environment-provisioning-plan.md OQ1/OQ2](environment-provisioning-plan.md#open-questions)
      and SPEC-release-path.md's verification status, cross-linked — plan updated with both
      reversals; the spec side lands with P5/P6's verdicts
- [~] ~~If the descope stands~~ — not applicable, both decisions reversed

**Verification**
- [x] If designated: `runway bootstrap`'s EP-06 audit *accepts* the project — **it did, the
      acceptance path's first-ever run** (12 created, no refusal) — and
      `gcloud projects get-iam-policy` confirmed independently: the only `run.*` binding is
      Google's own serverless service agent, no human deploy-capable role

**Dependencies:** None to decide; blocks P5, P6
**Files:** `tasks/environment-provisioning-plan.md`, `SPEC-release-path.md`
**Scope:** S — a decision, not code

---

### P5: Promote to production, observed
The verifications SPEC-release-path.md records as skipped, run for real: bootstrap production,
push a tag, watch CI resolve and deploy the digest.

**Acceptance criteria**
- [x] `runway bootstrap` provisions the production environment: WIF, state bucket, CI deployer,
      the IAM the boundary requires — 12 resources in 31s, plus the cross-project image-writer
      grant that run surfaced as missing (fixed, mock-tested, applied as one further create)
- [x] A pushed `v*` tag deploys production with the digest that tag resolves to —
      `v0.1.0 → sha256:8701285…`, in the run log, checksum-verified into the production registry.
      ~~responds on its private ingress~~ deployment read from the run's own API describe; the
      human cannot probe the service at all (`run.services.list` denied — recorded as evidence)
- [x] A tag absent from the registry fails the run before any `pulumi` step — **failure-injected
      live**: `v0.0.0-inject` on a commit CI never built died at the resolve step; nothing after
      it ran. Tag removed both sides afterwards
- [x] Results recorded in SPEC-release-path.md's verification status, verdict table replacing the
      "skipped" entries — including the first attempt's transient 503 from Google's token
      endpoint, retried to green

**Stop conditions**
- [x] **Gated on P4 and on explicit authorization** — both given; the one classifier-blocked IAM
      grant was handed to the user and run only on their go
- [x] Any state that cannot be cleanly reverted: none arose; the injected tag was removed

**Verification**
- [x] Deployed state read back through the GCP API — via the release run's own describe under the
      deployer identity; the human identity is denied even the read, by design
- [x] The run is attended — dispatches and tag pushes made and watched here, live

**Dependencies:** P4
**Files:** `test-integration/**`, `SPEC-release-path.md`
**Scope:** M — the plan's highest-risk task

---

### P6: The negative proofs — 403, no keys, rollback
The claims that make the boundary a fact. Each is an absence, so each is proven against injected
presence or direct observation, never asserted alone.

**Acceptance criteria**
- [~] A developer holding their full legitimate credentials runs `pulumi up --stack production`
      and receives **403 — observed, not asserted**. **Pending the operator's own hands**: the
      harness classifier blocks the attempt from here (it cannot know the denial is the point).
      Partially observed already: the same identity's read-only `run services list` is denied.
      The exact command was handed over; the verdict lands here and in the spec when pasted back
- [~] Zero user-managed keys, per account. **Pending the operator**: the granular admin set
      cannot even list keys — itself recorded as evidence of tightness — so the observed empty
      listing needs a self-granted `serviceAccountKeyAdmin`
- [x] Rollback, both halves: the `main` dispatch failed in 7s at `Refuse a non-tag ref` with the
      actionable message; the `v0.1.0` dispatch **re-resolved the digest itself** and redeployed
      it, actor `ivaravko` on the run record
- [x] Verdicts recorded in SPEC-release-path.md's table; the two pending items stated plainly as
      pending, not implied done

**Verification**
- [~] The 403 capture — pending the operator, as above
- [x] The rollback's non-tag refusal is the failure-injected half — run, watched, refused
- [x] Nothing granted this phase needs revocation: the deployer's grants are the boundary itself;
      the human's granular set is the standing admin posture; `run.viewer` was never granted
      (blocked, then found unnecessary)

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
