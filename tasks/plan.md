# Implementation Plan: gcp-components — SecureContainerService

Active plan. Implements [SPEC-secure-container-service.md](../SPEC-secure-container-service.md),
the first component of module `gcp-components` in the
[Platform capability map](../SPEC.md#capability-map).

Tasks: [tasks/todo.md](todo.md), numbered `C1`–`C8`.

**The runway-cli prototype is deferred, not dropped.** Its plan is preserved verbatim at
[tasks/runway-cli-prototype-plan.md](runway-cli-prototype-plan.md) and its remaining tasks (2–5)
sit under "Deferred" in [todo.md](todo.md). Component tasks use a `C` prefix precisely so that plan
keeps its numbering and its cross-references stay valid.

## Overview

Build the Cloud Run component that the whole paved road rests on: private by default, running under
a validated user-managed service account, with public exposure reachable only through a justified
opt-out that is recorded on the resource. Three enforcement layers — constructor defaults, mocked
unit assertions, and a CrossGuard policy pack for consumers who bypass the component entirely.

**Why this inverts the committed order.** [tasks/runway-cli-prototype-plan.md](runway-cli-prototype-plan.md)
scoped `gcp-components` out and asked, as its own first open question, whether proving scaffolding
was enough. [SPEC.md](../SPEC.md#capability-map) always had `gcp-components` first, for a reason the
prototype plan itself conceded: `runway new` is only worth shipping if the repo it emits actually
deploys. That makes "scaffold a repo, `pulumi preview` succeeds against real components" a genuine
end-to-end test instead of a template compiling against nothing.

## Toolchain Findings (verified, not assumed)

Every item here was checked against the real packages before this plan was written, because
TypeScript 7 has already broken two tools this repo depends on and a third failure would have
invalidated the task breakdown. **One of these is a blocker with a mitigation; the rest are green.**

| # | Question | Result |
|---|---|---|
| 1 | `npm install @pulumi/pulumi@3.259.0` alongside `typescript@7.0.2` | **FAILS** — `ERESOLVE` |
| 2 | `tsc` 7.0.2 typechecks a Pulumi `ComponentResource` | **PASS** — clean, with lib checking on |
| 3 | vitest 4.1.11 + `pulumi.runtime.setMocks()` | **PASS** — Outputs resolve correctly |
| 4 | `ts-node` under TS 7 | **BROKEN** — throws on `require` |
| 5 | `pulumi preview` without ts-node | **VIABLE** — see below |

**1 — the install blocker.** `@pulumi/pulumi@3.259.0` declares
`peerDependencies: { typescript: ">= 3.8.3 < 7", "ts-node": ">= 7.0.1 < 12" }`. TypeScript 7.0.2 is
outside that range, so npm refuses to resolve. Both peers are `optional: true`, so nothing actually
needs them at runtime — the range is stale metadata, not a real constraint.

Mitigation, verified end to end: `.npmrc` containing `legacy-peer-deps=true`. With it, install
succeeds, `tsc --noEmit` stays clean, and the mocked tests pass. This is the same class of stale
peer-range problem [SPEC.md](../SPEC.md#tech-stack) already documents for typescript-eslint — the
difference is that this one has a working escape hatch and typescript-eslint did not.

**It is a blunt instrument and the cost is real.** `legacy-peer-deps=true` disables peer checking
repo-wide, not just for Pulumi, so a genuinely incompatible peer elsewhere will now install silently
instead of erroring. Accepted because the alternative is pinning TypeScript 5.x and abandoning a
decision this repo has already paid for twice. C2 pins the exact versions that were verified
together, so the check the flag removes is replaced by a test.

**4 and 5 — ts-node is broken, and it turns out not to matter.** `require("ts-node").register({})`
throws `Cannot read properties of undefined (reading 'fileExists')` under TS 7: ts-node reaches for
`ts.sys`, which the native compiler does not export. Pulumi runs `.ts` programs through ts-node, so
on the face of it `pulumi preview` is dead — and with it SPEC success criteria 3, 5, 6 and 7.

It is not, because Pulumi only loads ts-node when asked to:

```js
// @pulumi/pulumi/cmd/run/run.js:234
const typeScript = process.env["PULUMI_NODEJS_TYPESCRIPT"] === "true";
// :279
if (typeScript) { /* ...register ts-node... */ }
```

That variable is set from `runtime.options.typescript` in `Pulumi.yaml`. With `typescript: false`
and a `main` pointing at compiled output, ts-node is never loaded and Pulumi runs plain JavaScript —
which `tsc` 7 emits perfectly well (finding 2). **Every stack and policy pack in this repo must
therefore be precompiled and declare `typescript: false`.** This is a constraint on C7 and on any
future integration work, not an optional optimisation.

## Architecture Decisions

**1. The restructure is its own task, and it comes first.** Moving `@runway/cli` into
`packages/runway-cli` touches every generated file in the repo. Bundled into a component task, a
broken restructure and a broken component become one thing to revert. C1 does the move and nothing
else; its acceptance test is that runway-cli's existing 15 tests still pass from a clean clone.

**2. Toolchain proof is a task, not an assumption (C2).** The findings above were verified in a
scratch directory. C2 reproduces them inside the repo — pinned versions, `.npmrc`, and a smoke test
that constructs a mocked Pulumi resource. Risk 1 is retired by a passing test in the PR gate rather
than by this document asserting it.

**3. The validator is pure and lands before the component (C3).** `assertUserManagedServiceAccount`
needs no Pulumi, no mocks, and no GCP. Splitting it out means CR-04 — the control carrying the most
weight now that the typed `SecureServiceAccount` guarantee is deferred — is tested in isolation, in
milliseconds, table-driven.

**4. Private path and public path are separate slices (C4, C5).** They are two different claims:
"the default is safe" and "the escape hatch works and is auditable". Each is independently testable
and independently revertable. C5 also carries the empty-justification rejection, which is the case
that would silently defeat the control.

**5. The policy pack lands after both paths (C7).** Its rules key off the `runway-public` label that
C5 introduces. Writing it earlier means writing rules against a convention that does not exist yet.

**6. Control-mapping completeness is enforced by a test, not by review (C8).**
[SPEC-secure-container-service.md](../SPEC-secure-container-service.md#success-criteria) requires
zero rows without tests and zero tests without rows. A doc that drifts from the suite is worse than
no doc, because it reads as proof. C8 parses `docs/control-mapping.md`, extracts the CR-* ids and
test names, and cross-references them against the actual suite.

## Dependency Graph

```
C1  packages/* restructure
 └── C2  gcp-components package + Pulumi/TS7 toolchain proof   ◄── highest risk, retired here
      └── C3  Service-account email validator (pure)
           └── C4  SecureContainerService — private default path
                ├── C5  Public access path (justified opt-out)
                │    └── C7  CrossGuard policy pack
                │         └── C8  control-mapping.md + completeness test
                └── C6  Binary Authorization (opt-in)
```

**C5 and C6 both attach to C4 but are not safely parallel** — both edit
`secure-container-service.ts`. Run them in sequence; the graph shows dependency, not concurrency.
Nothing else in this plan parallelises at this size.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| `@pulumi/pulumi` peer-caps TypeScript at `<7`; install fails outright | **High** — blocks everything | `.npmrc` `legacy-peer-deps=true`, verified working. C2 pins the exact trio verified together and asserts them in a test. |
| `legacy-peer-deps` hides a *real* incompatibility elsewhere later | Medium | Versions are pinned exactly, and `test/toolchain.test.ts` already asserts the pins. A silent drift becomes a failing test. |
| ts-node unusable, so `pulumi preview` and the policy pack look impossible | **High** if unmitigated | Precompiled JS + `runtime.options.typescript: false`. Verified in `run.js:234,279`. Binding constraint on C7. |
| projen has no npm-workspaces component; the `workspaces` array is hand-wired | Medium — a projen upgrade will not maintain it | Already documented in [SPEC.md](../SPEC.md#tech-stack). C1 asserts the array's contents in a test so an upgrade that drops it fails loudly. |
| `oxlint --type-aware` across two packages is unverified | Medium | C1's verification runs lint at the root over both packages before any component code exists. |
| Policy-pack unit testing has no established pattern under vitest | Medium | C7 tests rule functions directly rather than booting a PolicyPack. If that proves impossible, stop and report — do not weaken a rule to make it testable. |
| Restructure breaks the 15 passing runway-cli tests | Low | C1's sole acceptance test is that they still pass, from a clean clone. |

## Definition of Done

Per task, on top of each task's own acceptance criteria:

- [ ] Acceptance criteria met and verified by running it, not by typechecking
- [ ] `npm run build`, `npm test`, `npm run lint` pass at the root across both packages
- [ ] No `any`, no non-null assertions outside tests, no `TODO` markers
- [ ] Every hardening control added in the task has its control-mapping row, its named test, and
      its policy rule **in the same commit**
- [ ] No test requires GCP credentials or network beyond the npm registry
- [ ] Human review before the task is checked off

## Open Questions

1. **When does `serviceAccountEmail` become `SecureServiceAccount`?**
   ([spec OQ1](../SPEC-secure-container-service.md#open-questions)) v1 ships a runtime check where
   the module spec promised a compile-time one. Tightening before any consumer exists is a one-line
   breaking change; after publication it is a migration. Not blocking C1–C8.
2. **Can an out-of-band label edit defeat CR-03?** ([spec OQ2](../SPEC-secure-container-service.md#open-questions))
   `runway-public` is both the filterable signal and the policy pack's evidence of the public path.
   Removing it by hand leaves a public service invisible to the rule. Decide before C7 fixes the
   rule's shape.
3. **Two corrections are owed upstream in [SPEC-gcp-components.md](../SPEC-gcp-components.md)** —
   justification-as-label (impossible) and the Binary Authorization attestor premise (no such
   field). Changing a hardened default is ask-first, so these are proposed, not applied.
4. **Does `@pulumi/gcp` move to 9.35.1?** [SPEC.md](../SPEC.md#tech-stack) pins 9.35.0; all arg-surface
   verification was done against 9.35.1. C2 must pin one of them deliberately.
5. **Package registry and scope** ([SPEC.md OQ2](../SPEC.md#open-questions)) — `@runway/*` is a
   placeholder. Affects nothing before publishing, but C1 hard-codes the scope in two package names.
