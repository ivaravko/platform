# Implementation Plan: Platform

Covers both modules of the [Platform capability map](../SPEC.md#capability-map) in approved build
order. Tasks are tracked in [tasks/todo.md](todo.md) as one ordered list.

- **Part 1: `gcp-components`** (Tasks 1–12) — spec: [SPEC-gcp-components.md](../SPEC-gcp-components.md)
- **Part 2: `runway-cli`** (Tasks 13–22) — spec: [SPEC-runway-cli.md](../SPEC-runway-cli.md)

Checkpoint 3 is the gate between them.

> **Note on sequencing.** Part 2 was planned at the human's request before Checkpoint 2 settled the
> component pattern. Tasks 15 and 18 therefore target component APIs that do not yet exist and are
> the most likely to need revision. Tasks 13–14 and 20 are insulated from that — they depend on
> projen and the local toolchain only.

---

## Part 1: gcp-components

## Overview

Build a Pulumi component library for GCP service-runtime resources where the hardened configuration
is the default and every deviation is a named, justified opt-out. Three components — service
account, artifact repository, Cloud Run service — each proven by three layers: safe-by-default
constructors, Pulumi-mocked unit assertions, and a CrossGuard policy pack that catches consumers
who bypass the library entirely.

## Planning Assumptions

The spec's open questions are unresolved. Rather than block, I planned against these — **correct any
and I will re-slice the affected tasks**:

1. **Binary Authorization is opt-in for v1, not default-on.** It requires an attestor and org-level
   setup we do not have. Defaulting it on would make every generated stack undeployable.
2. **`docs/control-mapping.md` carries a `Source` column** citing CIS where a control genuinely
   exists and Google Cloud Run guidance otherwise. No invented CIS IDs.
3. **`@runway/*` is a placeholder scope.** Renaming is mechanical and blocks nothing.
4. **No GCP resource is created or previewed until explicitly authorised.** Task 12 is the only task
   requiring credentials, and it is parked as BLOCKED.
5. **`template.vpcAccess` is omitted entirely in v1** rather than stubbed. No networking module
   exists, so a half-configured egress path is worse than none.

## Architecture Decisions

**Walking skeleton is `SecureServiceAccount`, not the Cloud Run service.** It has zero dependencies
on other components, `SecureContainerService` consumes it as a typed argument, it carries the only
controls with honest CIS IDs, and its role-allowlist validation exercises the throw-at-construction
pattern the other components will reuse. Finishing it end to end — component, tests, policy rule,
mapping row — proves every layer of the architecture before the pattern is repeated twice.

**Slices are per-component, not per-layer.** Each component task delivers the constructor, its
hardened defaults, its unit assertions, its export, and its mapping rows together. Building all
three components and then all the tests would leave the hardening claim unproven until the very end,
which is precisely the claim the module exists to make.

**Guardrail enforcement is its own slice, separate from the happy path.** Task 3 proves
`SecureServiceAccount` produces a hardened account; Task 4 proves it *refuses* `roles/owner`. Same
for Task 8 (Cloud Run defaults) and Task 9 (the justified public-access opt-out). Splitting them
keeps each task at S/M and stops the negative cases from being written as an afterthought to a
task that already "works".

**The control-mapping doc is mechanically enforced (Task 11), not maintained by discipline.** The
spec says a control without a test is not a control. A test that parses the doc and asserts every
row names a real, passing test is the only thing that makes that true six months from now.

**Test infrastructure is a foundation task, not a per-component concern.** Task 2 exists solely
because Pulumi's mock harness against vitest 4 is unproven. It is deliberately isolated so it can
fail alone rather than inside the first component task.

## Dependency Graph

```
Task 1  projen monorepo bootstrap
   │
   ├── Task 2  Pulumi mock harness  ──────────────────┐
   │      │                                           │
   │      ├── Task 3  SecureServiceAccount + conventions
   │      │      │
   │      │      ├── Task 4  Role allowlist enforcement
   │      │      │
   │      │      └── Task 8  SecureContainerService ── Task 9  publicAccess opt-out
   │      │                                                       │
   │      └── Task 6  SecureArtifactRepository                     │
   │                                                               │
   └── Task 5  Policy pack harness + first rule                    │
          ├── Task 7   AR policy rule (immutable tags)             │
          └── Task 10  Cloud Run policy rule (public ingress) ◄────┘
                 │
                 └── Task 11  Control-mapping completeness gate
                        │
                        └── Task 12  Integration preview  [BLOCKED]
```

Build order follows bottom-up: foundation (1–2), walking skeleton (3–5), repetition (6–10),
enforcement (11), integration (12).

## Parallelisation

Once Checkpoint 2 passes, two independent streams open up:

- **Stream A:** Task 6 → Task 7 (Artifact Registry)
- **Stream B:** Task 8 → Task 9 → Task 10 (Cloud Run)

They share only `conventions/` and the test harness, both frozen by Checkpoint 2. Task 11 joins
them and must wait for both. Tasks 1–5 are strictly sequential — each proves a foundation the next
depends on.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| TypeScript 7.0.2 shipped days ago; projen 0.103.2 predates it and may not drive it | **High** — blocks Task 1 entirely | Task 1's acceptance criteria prove the combination before anything is built on it. Fallback: pin TS 5.x latest, record an ADR, revisit when projen catches up. Cost of discovering this at Task 1 is ~1 hour; at Task 8 it is a rewrite. |
| `pulumi.runtime.setMocks()` is documented against Mocha/Jest, not vitest 4 | **High** — blocks every unit test | Task 2 isolates it with a throwaway assertion. Fallback in order of preference: vitest with explicit `pool: 'forks'`, then `node:test`, then jest. |
| `@pulumi/policy` has no documented offline unit-test harness | **Medium** — layer 3 of 3, additive | Task 5 isolates it. Fallback: extract each rule's predicate as a pure function, unit-test that directly, and verify the assembled pack once in the nightly `pulumi preview` rather than on every PR. |
| projen subprojects + pnpm workspaces is a less-travelled combination | **Medium** — blocks Task 1 | Proven by Task 1's idempotence criterion. Fallback: npm workspaces, which projen supports natively. |
| Pulumi mocks return synthetic values, so a test can pass while the real provider rejects the config | **Medium** — false confidence in hardening | Exactly what Task 12 exists to catch. Until it is unblocked, hardening claims are "asserted", not "verified against GCP" — the plan does not overstate this. |
| CIS GCP Foundations Benchmark has no Cloud Run or Artifact Registry section | **Low** — documentation only | `Source` column per assumption 2. Components and tests are unaffected. |
| Scope creep into data stores / networking / secrets | **Medium** — v1 never ships | v1 scope is fixed at three components. Any addition is an explicit spec change, not a task. |

## Definition of Done (project-wide)

Tailored once from `references/definition-of-done.md`; applies to every task on top of its own
acceptance criteria.

- [ ] Acceptance criteria met, and behaviour verified by running it — not by typechecking alone
- [ ] New behaviour covered by a test that fails without the change
- [ ] `pnpm build`, `pnpm test`, `pnpm lint` all pass; no regressions
- [ ] No `any`, no non-null assertions outside tests, no dead or commented-out code
- [ ] Every public args member carries TSDoc
- [ ] Any new hardened default lands with its mapping row and its test in the same commit
- [ ] Changes scoped to the task; no opportunistic refactors
- [ ] Human review before the task is checked off

## Open Questions

Carried from [SPEC.md](../SPEC.md#open-questions), plus planning-specific ones:

1. **Confirm or correct the five planning assumptions above** — particularly Binary Authorization
   (2) and the CIS `Source` column (1). Both are cheap to change now and expensive at Task 11.
2. **Is `project-4da1a7fd-3681-4524-853` a disposable sandbox?** Task 12 stays BLOCKED until
   answered. Nothing else in the plan needs credentials.
3. **Mandatory label set** — which keys are required, and does a missing `owner` throw or warn?
   Needed by Task 3; I will default to throw-on-missing-`owner` if unanswered.
4. **Role allowlist contents** — Task 4 rejects `roles/owner`, `roles/editor`, and `*Admin`. Is
   that the full denylist, or do you want an explicit allowlist of permitted roles instead? A
   denylist is easier to adopt; an allowlist is genuinely safer. I recommend the allowlist.
5. **Cleanup policy retention** — the spec says "keep N most recent". What is N, and is 30 days
   right for untagged images? Needed by Task 6.

---

## Part 2: runway-cli

### Overview

Build a projen-based scaffolder that emits a minimal, deployable service repository — build, test,
lint, CI, container, and a hardened Pulumi stack composing `gcp-components`. Success is measured by
one thing: the generated repo builds and deploys **unmodified**. A scaffold whose output needs edits
before it works is worse than no scaffold, because it teaches teams the paved road is broken.

### Architecture Decisions

**Build `RunwayServiceProject` before deciding how the CLI is distributed.** The projen project type
is needed identically whether we ship a global `bin`, an `npx` entry, or a projen external project
type (`npx projen new --from @runway/cli`). Building the common core first means the unresolved
distribution question (SPEC.md Open Question 5) blocks exactly one task — Task 18 — instead of
gating the whole module. If the answer turns out to be the projen-native path, we throw away an
argument parser rather than a week.

**The build-out harness is Task 13, before anything it verifies.** Every subsequent task's
acceptance criterion is "scaffold it into a temp directory and build it for real". That harness has
two genuinely hard problems — resolving an unpublished `@runway/gcp-components`, and installing
fast enough to sit on a PR gate — and both deserve to fail alone.

**Slices are per-generated-concern, not per-file.** Task 14 emits a repo that builds. Task 15 adds
infra that typechecks against real components. Task 16 adds the container. Task 17 adds CI. Each
leaves the scaffold in a working, testable state, and each can be verified by building the output
rather than by reading it.

**`infra/index.ts` is the load-bearing artifact (Task 15).** It is the worked example every team
copies, so it must compose components with zero raw `gcp.*` resources. If teams learn raw-resource
habits from our own scaffold, the policy pack becomes an adversary rather than a guardrail.

**Minimality is enforced by a test, not by review discipline (Task 21).** The spec sets a 200-line
budget on generated output. Budgets that live only in a reviewer's head are exceeded within three
PRs.

### Dependency Graph

```
Checkpoint 3  (components exist and are stable)
   │
   └── Task 13  Build-out test harness  ────────────── Task 20  runway doctor
          │                                              (independent of all scaffolding)
          └── Task 14  RunwayServiceProject: repo that builds   ◄── walking skeleton
                 │
                 ├── Task 15  infra/ composing gcp-components   [Stream C]
                 ├── Task 16  Service skeleton + Dockerfile     [Stream D]
                 ├── Task 17  Generated CI workflow             [Stream E]
                 │
                 └── Task 18  CLI entry point  [BLOCKED: distribution]
                        │
                        └── Task 19  Scaffold guardrails (--force, --dry-run)
                                  │
                                  └── Task 21  Idempotence + minimality gate
                                         │
                                         └── Task 22  End-to-end acceptance  [partly BLOCKED]
```

### Parallelisation

After Task 14, Streams C (infra), D (container), and E (CI) are independent — they emit different
files into the same scaffold and share only the project type's file-registration API. Task 20
(`doctor`) touches no scaffolding at all and can run at any point after Task 13. Tasks 21 and 22
join every stream and must wait for all of them.

### Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Distribution unresolved.** If the answer is "projen external project type", Task 18's argument-parsing layer is discarded entirely | **High** — one wasted task | Task 18 is the *only* task that depends on the answer, by deliberate design. Answer it before Task 18 starts and the waste is zero. |
| **Bootstrapping paradox.** The generated repo's `.projenrc.ts` imports `@runway/cli`, and its `infra/` imports `@runway/gcp-components` — neither published during development | **High** — blocks Task 13 | Harness resolves both via pnpm `workspace:`/`file:` protocol in tests, exact published versions in production. The two paths must be proven to produce identical output, or tests validate something users never run. |
| **Build-out tests are slow.** A real `pnpm install` per test can take 30–60s | **Medium** — unusable PR gate | Shared pnpm store, `--offline` where possible, one build-out fixture reused across assertions rather than one per test. If the gate exceeds ~3 min, move build-out to a merge-queue check and keep generation-only assertions on PR. |
| **200-line budget may be unachievable** once Dockerfile, CI, README, and infra are all present | **Medium** — either the budget or the scope gives | Rough allocation: projenrc ~20, service ~25, test ~15, infra ~40, Pulumi.yaml ~5, Dockerfile ~20, README ~40 ≈ 165. README is the compressible one. Task 21 measures it; if it cannot be met, we revise the number deliberately rather than quietly. |
| **Generated CI needs GCP credentials for `pulumi preview`** | **Low** — consumer's concern | Our PR gate never runs the generated repo's CI. Task 17 asserts the workflow's *shape*, and that it fails closed with a clear message when credentials are absent. |
| **Planned before Checkpoint 2**, so component APIs may shift under Task 15 | **Medium** | Task 15 is scheduled after Checkpoint 3, when components are frozen. Re-read the component API before starting it rather than trusting this plan's assumptions. |

### Open Questions (runway-cli)

Carried from [SPEC-runway-cli.md](../SPEC-runway-cli.md#open-questions):

1. **Distribution — answer before Task 18.** Global npm install, `npx runway`, or projen external
   project type? I recommend the **projen external project type**: it is the most projen-native
   path, removes our CLI from the critical path, and means one less binary to version and
   distribute. The cost is a slightly less friendly first-run command.
2. **GCP project and region** — flags, prompts, or `~/.runway/config.toml`? Recommendation: flags
   with prompt fallback, so CI use stays scriptable and interactive use stays pleasant.
3. **CI provider** — GitHub Actions assumed. projen supports GitLab CI if that is wrong.
4. **Does the scaffold `git init` and commit?** Recommendation: yes, one initial commit, so the
   first `npx projen` regeneration produces a clean, reviewable diff.
5. **Generated service language** — TypeScript assumed. Python or Go support would require a
   language parameter on the project type and makes the 200-line budget substantially harder.
