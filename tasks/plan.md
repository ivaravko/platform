# Implementation Plan: v1 completion — the paved road actually deploys

Active plan. Follows [tasks/gcp-components-plan.md](gcp-components-plan.md) (C1–C8, complete) and
[tasks/runway-cli-prototype-plan.md](runway-cli-prototype-plan.md) (Tasks 1–5, complete).

Tasks: [tasks/todo.md](todo.md), numbered `D1`–`D7`. Completed history:
[tasks/completed-v1.md](completed-v1.md).

## Overview

Four of six [SPEC.md success criteria](../SPEC.md#success-criteria) are met. This phase closes the
other two and the v1 component gap behind them.

| # | Criterion | State |
|---|---|---|
| 1 | Clean clone builds and tests | ✅ |
| 2 | `runway new` produces a repo that builds, tests, lints | ✅ |
| 3 | **That repo's `pulumi preview` plans one repo, one SA, one service** | ❌ **the scaffold emits no `infra/` at all** |
| 4 | Every control-mapping row links to a passing test | ✅ |
| 5 | Policy pack fails a raw public service | ✅ (proven against live GCP) |
| 6 | **Both packages publish with independent semver tags** | ❌ not configured |

Criterion 3 is the whole premise. [SPEC.md](../SPEC.md#capability-map) puts it plainly: *"`runway-cli`
is only worth shipping if the repo it emits actually deploys."* Today it emits a repo that builds and
lints and deploys nothing.

## The finding that sets the order

**A scaffolded repo cannot run the guardrails built for it.**

`RunwayServiceProject` pins `typescript@7.0.2` (`runway-service-project.ts:21`), matching the
platform. C7 established that Pulumi's policy-pack runner hardcodes ts-node on
(`cmd/run-policy-pack/index.js:110`), ignores `PulumiPolicy.yaml`, and falls back to its vendored
`typescript@3.8.3` **only when `require("typescript")` throws**. TypeScript 7 imports fine, so the
fallback never fires and the pack dies on `ts.sys.readFile`.

Every scaffolded repo therefore has TypeScript 7 resolvable at its root, and **the CrossGuard pack
cannot load from inside it**. The paved road currently hands teams a repo whose guardrails it cannot
execute. Nothing in the enforcement layer changes this — it is a property of how the pack is
consumed, not of the rules.

That makes D1 the first task and a genuine fork: it may be resolvable by packaging, or it may force
a decision about the generated repo's TypeScript version. **D1 carries a stop condition** — if
neither route works without weakening a control, stop and report rather than shipping a pack that
silently never runs.

## Architecture Decisions

**1. The blocker goes first (D1).** Highest-risk item, and it invalidates part of the design if
unsolvable. Everything in Phase E that claims "the generated repo enforces its own guardrails"
depends on it. Discovering this after building the infra emitter would mean rebuilding it.

**2. `SecureServiceAccount` before tightening `SecureContainerService` (D2 → D4).**
[The component spec's OQ1](../SPEC-secure-container-service.md#open-questions) asks when
`serviceAccountEmail: pulumi.Input<string>` becomes the typed `SecureServiceAccount` the module spec
promised. The answer is *before publishing*: with no consumers it is a one-line breaking change; after
D7 it is a migration. It also closes C4's documented gap — the failing-`Output` path that vitest
cannot test disappears entirely if the argument stops being a string.

**3. No `infra/` emission until all three components exist (D2, D3 → E1).** The archived prototype
plan refused to emit infrastructure early for a specific reason: it would mean either raw `gcp.*`
resources — teaching exactly the habit the product exists to prevent — or waiting on components.
That reasoning still holds.

**4. Publishing last (D7).** Publishing freezes the public API. Everything that might break it —
the typed service-account argument especially — lands first. This is the one ordering constraint
that is expensive to get wrong.

## Dependency Graph

```
D1  Policy pack must run where it is consumed   ◄── highest risk, may force a decision
 │
 ├── D2  SecureServiceAccount
 │    └── D4  SecureContainerService takes SecureServiceAccount (closes spec OQ1 + C4's gap)
 │
 ├── D3  SecureArtifactRepository
 │
 └──────────┬─────────────────┘
            └── E1 (D5)  Scaffold emits infra/ using all three components
                  └── D6  Generated repo's `pulumi preview` succeeds  (success criterion 3)
                        └── D7  Publishing with independent semver tags  (success criterion 6)
```

D2 and D3 are genuinely independent and touch disjoint files — the only parallelisable pair here.
D1 is independent of both but gates the *value* of D6, so it is scheduled first rather than beside
them.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| The policy pack cannot be made to run in a TS 7 consumer at all | **High** — the third enforcement layer becomes decorative for every scaffolded repo | D1's stop condition. If packaging cannot solve it, the choice is the generated repo's TS version, and that is a decision to surface, not to take silently. |
| Tightening the service-account argument after publishing | **High** if delayed | D4 precedes D7 deliberately. No consumers exist today. |
| The role allowlist has no agreed contents | Medium — blocks D2's central control | [Open question 1](#open-questions). A wrong allowlist is worse than none: it grants confidence without cover. |
| Emitting `infra/` breaks the scaffold's minimality constraint | Medium | E1 asserts the emitted file tree exactly, as Task 2 and Task 4 already do. |
| `pulumi preview` in generated CI needs GCP credentials | Medium — the PR gate must stay credential-free | D6 verifies preview locally against the sandbox; wiring it into *generated* CI is explicitly out of scope here and returns with a decision about Workload Identity. |
| `main`'s history was rewritten mid-session once already | Low, but it wasted two merges | Check for a common ancestor before merging, not after. |

## Definition of Done

Per task, on top of its own acceptance criteria:

- [ ] Acceptance criteria met and verified by running it, not by typechecking
- [ ] `npm run build`, `npm test`, `npm run lint` pass at the root across all packages
- [ ] Every new hardening control has its control-mapping row, named test, and policy rule **in the
      same commit** — and the C8 completeness test enforces both directions
- [ ] Negative tests prove the failure path, and are **mutation-tested**: break the thing the test
      protects and confirm it fails. Three silent-passes in C5–C8 were found only this way
- [ ] No test requires GCP credentials or network beyond the npm registry
- [ ] Human review before the task is checked off

## Open Questions

1. **What is on the role allowlist?** ([SPEC-gcp-components.md](../SPEC-gcp-components.md#secureserviceaccount))
   says roles come from "an explicit vetted set" and that `roles/owner`, `roles/editor` and `*Admin`
   throw. The denials are clear; the allowances are not. Blocks D2's central control. My
   recommendation: start with an **empty** allowlist and an explicit `roles` argument validated
   against the denial rules — a positive allowlist nobody has vetted is worse than an honest denial
   list, for the same reason the CR-04 hint list is cosmetic and the positive rule is the boundary.
2. **Should the generated repo pin TypeScript 7?** Forced by D1 if packaging cannot solve it.
   Pinning 5.x lets the pack run and costs the scaffold nothing the platform needs; keeping 7 keeps
   platform and scaffold aligned but leaves the guardrail unrunnable. Not mine to decide.
3. **Registry and scope** ([SPEC.md OQ2](../SPEC.md#open-questions)) — `@runway/*` is a placeholder.
   Blocks D7 and changes the generated repo's `.npmrc`.
4. **Two corrections owed upstream** in [SPEC-gcp-components.md](../SPEC-gcp-components.md):
   justification-as-label (impossible — GCP label values reject it) and the Binary Authorization
   attestor premise (no such field). Both proposed in C5/C6 and still unapplied, because changing a
   hardened default is ask-first.
5. **Is "exactly one repo, one SA, one service" still the target for criterion 3?** It was written
   before the components existed. Confirm before E1 emits to it.
