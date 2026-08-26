# Implementation Plan: v1 close-out — the digest boundary, and the proof that was skipped

Active plan. The last two capability-map modules — [service-stacks](../SPEC-service-stacks.md) and
[release-path](../SPEC-release-path.md) — are specified, largely built, and partly verified. This
plan is deliberately not a module build-out: it is the **gap list** between what those specs promise
and what exists, found by auditing every success criterion against `main` at `f87f9bb`.

Tasks: [tasks/todo.md](todo.md), numbered `P1`–`P7`. Preceding plans:
[environment-provisioning](environment-provisioning-plan.md) (E1–E9 complete; E7 partially
descoped), [local-development](local-development-plan.md) (closed),
[v1-completion](v1-completion-plan.md), [integration-tests](integration-tests-plan.md),
[gcp-components](gcp-components-plan.md), [runway-cli](runway-cli-prototype-plan.md).
Task history: [tasks/completed-v1.md](completed-v1.md).

## Overview

What the audit found, stated as facts about `main`:

- **SS-02 is a control with no enforcement and no test.** The spec's own testing strategy marks it
  *Blocking*: "a tag reference in `Pulumi.production.yaml` fails the build." Nothing fails. The
  generated program deliberately never branches on stack name (SS-01), so it *cannot* refuse a tag
  on production — the enforcement has to live outside the program, and nothing outside the program
  checks. A team that writes `imageTag: v2` into their production config gets a production service
  tracking a mutable reference, silently, which is the exact failure the module exists to prevent.
- **Test coverage of the SS controls is one of six.** `SS-01` appears in a test name; SS-02 through
  SS-06 appear in none. Some are likely asserted under other names (SS-06's length rule is
  implemented in `new.ts` with messages), but the repo's own discipline — a control without a named
  test is not a control — is currently unmet for five ids. RP is in better shape: RP-01/02/03/05/06
  all appear.
- **The production half of release-path is designed, not observed.** The spec records it plainly
  (2026-08-26): RP-04 is observed against the real `first01` staging service, and everything
  production-side — a tag push federating into production, RP-01/RP-02/RP-06 at runtime, the
  developer 403, the no-user-managed-keys check — **was skipped**, because no project can serve as
  a clean production target while the sandbox grants `roles/owner` to a human. The E-series
  resolved this **twice over, both as "no"** on 2026-08-26:
  [its OQ1](environment-provisioning-plan.md#open-questions) closed as *refusal-only* (no clean
  target exists), and its OQ2 closed as *preview-only* (`runway bootstrap` is not authorized to
  write IAM anywhere, "until this decision is revisited"). So the production proofs are not blocked
  on an open question — they are blocked on two standing decisions, and P4 is the explicit revisit
  those decisions invited.
- **One spec decision is still open**: whether `staging` may be public (service-stacks OQ3) — and
  it hides a sharper question than the spec asks, because one program serves both stacks, so a
  per-stack opt-out must key on config, not on code.
- **Two spec notes have drifted from the code**: the `?? "v1"` fallback the Corrections section says
  is "deliberately left" no longer exists (the program now throws, naming both keys), and whether
  SS/RP ids belong in `docs/control-mapping.md` — whose completeness test is bidirectional — has
  never been decided. EP rows were added when that module landed; SS/RP rows were not.

## Architecture decisions

**1. SS-02 enforcement lives in the generated repo's build, not in the program.** SS-01 forbids the
program from knowing which stack it is, so the program cannot be the enforcement point — and the
spec already resolved the mechanism: a generated `Pulumi.production.yaml` carries **no image at
all**; CI writes `imageDigest` at promotion. What is missing is the check that keeps it that way: a
generated test (it runs in the repo the team owns, where the config lives and drifts) asserting the
production stack config contains no `imageTag` and no image reference that is not a digest. The
platform's generation tier then asserts that check is emitted and fails when a tag is injected —
enforcement proven by failure injection, per the house rule.

**2. The production proof is one gated phase, sequenced last.** Everything real-GCP was skipped for
the same root cause — no clean production target — so it is planned as one decision (P4) followed
by one attended verification session (P5, P6) with explicit stop conditions, not smeared across
tasks. Offline gaps (P1–P3) land first and are unblocked today; nothing in them touches GCP.

**3. This plan closes v1 rather than opening new scope.** Every task traces to an existing spec's
success criterion or open question. Anything discovered beyond that gets recorded as an open
question for a future plan, not absorbed.

## Dependency graph

```
P1  SS-02: the digest check          ─┐  offline, unblocked
P2  SS/RP coverage audit  (after P1) ─┤
P3  staging-public decision          ─┘  P3 parallel with P1→P2

P4  the production-project decision  ──►  P5  promote to production, observed
                                          │
                                          ▼
                                          P6  the negative proofs: 403, no keys, rollback

P7  v1 truth pass  ◄── everything above
```

P1 and P2 both touch the scaffold's test files and are sequential. P3 touches spec and docs only —
the one safely parallel task. P4 is a decision, not code; P5 and P6 are gated on it and on explicit
authorization. P7 closes the map.

## Checkpoints

- **Checkpoint 1 — after P3.** Every SS and RP control has a named test or a recorded reason it
  cannot have one; a tag injected into a production stack config fails a build, demonstrably; the
  staging-public question is answered in the spec. All offline, all in the PR gate.
- **Checkpoint 2 — after P6.** Either: production observed — a tag push deploys the resolved
  digest, a credentialed human's `pulumi up --stack production` returns 403, zero user-managed keys
  exist, and a dispatch on an old tag redeploys its digest — or: what remains unverified is stated
  in SPEC-release-path.md's verification status with the reason, and nothing was weakened to
  manufacture a pass.
- **Checkpoint 3 — after P7.** The capability map, README, and completed history agree with
  reality; no spec claims more than was observed; human review of the whole v1 claim.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **SS-02's check can be deleted by the team it polices.** It lives in the generated repo, which the team owns after `runway new`. | Medium — the control is advisory once the repo drifts | Accepted and stated: the scaffold's premise is defaults you must work to remove, not defaults you cannot. The platform-side generation test keeps every *new* repo honest; nothing can keep a team's fork honest without a server-side control, which is new scope. Recorded in the spec rather than implied. |
| **P5 writes to a real production-designated project.** IAM grants, a state bucket, a deployed service. | High — the repo's sharpest boundary | Same regime as E7: gated on the P4 decision *and* explicit authorization per SPEC.md's boundaries; every grant recorded for revocation; stop-and-report over improvisation. The `first01` staging run is the template. |
| **No project can be designated, and P5/P6 stay blocked.** The sandbox's `roles/owner` binding makes EP-06 refuse it — correctly. | High — v1's central claim stays a design | The honest fallback is explicit: record production verification as permanently descoped in both specs, close v1 with that caveat on the front page, and stop. Do not weaken EP-06; do not call designed "observed". |
| **The parallel session.** This checkout has had another active session all day; `main` moved four times during the last feature. | Medium — merge collisions in the same template file | Small commits, rebase before push, and the active-pair rename is committed with the plan so the state is unambiguous. The collision protocol from the local-development merge worked; reuse it. |
| **SS-02 vs SS-01 tension re-emerges in implementation** — someone "fixes" enforcement by branching the program on stack name. | Medium | The architecture decision above names the resolved mechanism; P1's acceptance criteria forbid touching the program at all. |

## Definition of Done

Per task, on top of its own acceptance criteria:

- [ ] Acceptance criteria met by running it, not by typechecking
- [ ] `npm run build`, `npm test`, `npm run lint` pass at the root across all packages
- [ ] **Every negative assertion is failure-injected** — no absence asserted without injected
      presence
- [ ] No test in the PR gate requires GCP credentials or network; P5/P6 run in the gated
      integration tier only
- [ ] Spec verification-status sections updated in the same commit as the verification they record
- [ ] Human review before the task is checked off

## Open Questions

1. **Do the two standing "no" decisions get reversed?** The E-series closed its OQ1 as
   *refusal-only* (no clean production target) and its OQ2 as *preview-only* (no IAM writes,
   explicitly "until this decision is revisited"). P5 and P6 need **both** reversed: a designated
   clean project, and write authorization scoped to it. The alternative is confirming the descope
   as v1's final answer. **This is P4, and it is the user's decision — two decisions, not one.
   Blocks P5 and P6, nothing earlier.**
2. **May staging be public?** Service-stacks OQ3. The opt-out exists (`publicAccess` with a
   justification); the open half is confirming it can be exercised per stack when one program
   serves both — which means keying it on config. Resolved in P3.
3. **Do SS/RP ids get rows in `docs/control-mapping.md`?** The mapping's completeness test is
   bidirectional, so adding them is a commitment, not a formality. EP set the precedent when its
   module landed. Decided in P2, ask-first.
