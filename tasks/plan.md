# Implementation Plan: environment-provisioning — the identity boundary

Active plan. Next module in the [capability map](../SPEC.md#capability-map) build order, and the
first one whose whole purpose is to make something **impossible** rather than easy.

Tasks: [tasks/todo.md](todo.md), numbered `E1`–`E9`. Preceding plans:
[v1-completion](v1-completion-plan.md) (D1–D6 complete, D7 outstanding),
[integration-tests](integration-tests-plan.md) (T1–T10 complete, T11–T12 outstanding),
[gcp-components](gcp-components-plan.md), [runway-cli](runway-cli-prototype-plan.md).
Task history: [tasks/completed-v1.md](completed-v1.md).

## Overview

[SPEC-environment-provisioning.md](../SPEC-environment-provisioning.md) states the module in one
sentence: **a developer holding every credential they legitimately possess still cannot deploy to
production.** Everything else is mechanism.

That makes this module different from everything built so far. `gcp-components` hardens *defaults*
and offers justified opt-outs; a determined caller can still reach the unsafe configuration by
saying why. Here there is no opt-out, because the thing being prevented is a person with legitimate
credentials doing something they are trusted to do everywhere else. The control is the absence of a
grant, and absence is exactly what this codebase has repeatedly failed to test — every silent-pass
found in C5–D6 was an assertion that could not tell "absent" from "never ran".

Seven controls, EP-01 to EP-07. All seven of the spec's open questions are **resolved**, so this is
decision-complete: nothing below waits on an answer.

## What is already true

| Module | State |
|---|---|
| `gcp-components` | Complete — three components, ten policy rules, controls mapped bidirectionally |
| `runway-cli` | Complete — scaffolds a repo whose `pulumi preview` plans correctly (criterion 3) |
| `integration-tests` | T1–T10 complete; **T11–T12 outstanding** and folded in here as E8 |
| `environment-provisioning` | Specified, decision-complete, **not built** — this plan |
| `service-stacks` | Specified, 3 open questions, blocked on this module |
| `release-path` | **No spec yet** |
| Publishing (D7) | Outstanding, and deliberately still last — see below |

## Architecture Decisions

**1. The permission set comes first (E1).** EP-01, EP-02 and EP-06 all turn on one question: *what
counts as deploy-capable?* The spec resolved it as Cloud Run's deploy permissions matched by verb,
not by role name. Every other control consumes that answer, and getting it wrong makes three
controls wrong in the same direction — silently permissive. It is also pure logic, so it is the one
piece that can be exhaustively tested offline.

**2. Staging before production (E3 → E5).** The spec makes `--production-project` optional and
staging the common starting point. Building staging first also means the dangerous half — the module
that must *refuse* — lands after the safe half works, rather than being debugged alongside it.

**3. The audit (E2) precedes the component that depends on it (E5).** EP-06 refuses a production
project that already grants a deploy-capable role to a human. It never repairs. That is a read-only
analysis over an IAM policy, testable against fixtures, and it must be right before anything writes
IAM anywhere.

**4. `ServiceEnvironment` twice, never `isProduction`.** Straight from the spec, and worth restating
because it is the kind of thing that erodes under a deadline: two instances of a reviewed component
beat one component with a branch, because the branch is where the boundary silently softens.

**5. Publishing stays last (E9).** This module adds a *third* published package. Freezing the API
before its own integration run has confirmed the boundary holds would be the same mistake D7 was
scheduled after D4 to avoid.

**6. This is the first module that mutates a real project.** Everything to date has been
`preview`-only, with one authorized `up` that was torn down. `runway bootstrap` grants IAM. E7 is
scoped and gated accordingly, and the plan does not assume that authorization is already given.

## Dependency Graph

```
E1  The deploy permission set (roles.ts)        ◄── three controls key on this
 ├── E2  EP-06 audit: refuse, never repair
 │
 ├── E3  ServiceEnvironment — staging (EP-04, EP-05)
 │        │
 │        └── E4  Workload Identity Federation (EP-03)
 │              │
 │              └── E5  ServiceEnvironment — production (EP-01, EP-02)
 │                       │   composes E2's audit and E4's federation
 │                       └── E6  runway bootstrap (EP-07)
 │                              └── E7  Integration: prove the boundary in GCP
 │
 └────────────────────────────────────────────────┐
                                                  ▼
                             E8  T11–T12: the integration workflow
                                    └── E9  D7: publishing, three packages
```

E2 and E3 both depend only on E1 and touch disjoint files — the one safely parallel pair. E8 is
independent of the whole E-chain and could run at any point; it is placed late only because it
closes out a different plan.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **The sandbox cannot serve as a production project for E7.** `ihar@perfinium.tech` holds `roles/owner` on `enduring-badge-506610-u9`, so EP-06 must *refuse* it. That is the control working, and it means the happy path cannot be demonstrated there. | **High** — E7's central assertion has nowhere to run | [Open question 1](#open-questions). Options: a second project, or an owner-free project. Do not weaken EP-06 to make the test pass. |
| Proving a negative — "no human can deploy" — is the assertion class this repo keeps getting wrong | **High** | Every EP control gets a **failure-injection** counterpart, as T10 did: grant the thing, prove the check fires, revoke it. An absence assertion with no injected presence is not evidence. |
| `runway bootstrap` writes IAM to a real project | **High** — hard to reverse, and IAM mistakes are exactly the failure mode | E7 is gated on explicit authorization, applies to staging first, and records exactly what it granted so it can be revoked. |
| WIF provider misconfiguration silently accepts a wider audience than intended (any repo, any ref) | **High** — a boundary that looks present and is not | E4 asserts the attribute condition rejects a wrong repo *and* a wrong ref, not merely that a condition string exists. |
| Adding a third package to the workspace | Low | C1 established the pattern; the `workspaces` array is test-asserted. |
| `service-stacks` was specified in parallel and may not match what gets built | Medium | Its 3 open questions are surfaced here rather than discovered during E6. |

## Definition of Done

Per task, on top of its own acceptance criteria:

- [ ] Acceptance criteria met by running it, not by typechecking
- [ ] `npm run build`, `npm test`, `npm run lint` pass at the root across all packages
- [ ] Every control has its mapping row, named test, and — where a raw resource could bypass it —
      a policy rule, **in the same commit**
- [ ] **Every negative assertion is failure-injected.** Grant the thing, watch the check fire, revoke
      it. Four silent-passes were found in C5–D6 and every one was an absence that could not fail
- [ ] No test requires GCP credentials or network beyond the npm registry, except the E7 tier, which
      is explicitly gated
- [ ] Human review before the task is checked off

## Open Questions

1. **Which project does E7 audit as "production"?** The sandbox cannot be it: the account holds
   `roles/owner` there, so EP-06 must refuse it — correctly. Proving the *refusal* is easy and
   valuable; proving the *acceptance* path needs a project with no human deploy binding. A second
   sandbox, or a subfolder project, or accept that E7 verifies only the refusal and the staging path.
   **Blocks E7, nothing earlier.**
2. **Is `runway bootstrap` authorized to write IAM, and to which projects?** Everything so far has
   been preview-only. This is the first module whose point is a durable grant. Needed before E7,
   not before E1–E6.
3. **`service-stacks` carries 3 unresolved open questions** and depends on this module. Worth
   resolving before E6 fixes the shape of `--print-config`, since that is the seam between them.
4. **`release-path` has no spec.** It is last in the build order, so this does not block the E-series
   — but it is the module that makes the boundary *usable*, and its absence should be deliberate.
5. **Does `environment-provisioning` publish?** It is a third package. If the registry answer from
   [D7](v1-completion-plan.md#open-questions) is still open, it is now open for three packages
   rather than two.
