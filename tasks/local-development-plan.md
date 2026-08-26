# Implementation Plan: local-development — the loop the scaffold never had

Active plan. A feature of `runway-cli`, not a module in the
[capability map](../SPEC.md#capability-map) — see
[SPEC-local-development.md](../SPEC-local-development.md) for why it gets a feature spec and no row.

Tasks: [tasks/local-development-todo.md](local-development-todo.md), numbered `L1`–`L5`. Spec:
[SPEC-local-development.md](../SPEC-local-development.md), requirements `LD-01`–`LD-09`.

**This plan carries its own task list**, the way
[integration-tests-plan.md](integration-tests-plan.md) does. `tasks/plan.md` and `tasks/todo.md`
stay with `environment-provisioning`.

> **Corrected, 2026-08-26.** This was briefly promoted to the active `plan.md`/`todo.md` pair on the
> understanding that `environment-provisioning` was paused with all nine tasks outstanding. That was
> wrong by the time it was written: **E1–E4 landed on `main` while this feature was being built.**
> The promotion was reverted rather than merged, because it would have overwritten an actively
> maintained list and recorded four completed tasks as untouched.

Preceding plans: [v1-completion](v1-completion-plan.md),
[integration-tests](integration-tests-plan.md), [gcp-components](gcp-components-plan.md),
[runway-cli](runway-cli-prototype-plan.md). Task history: [tasks/completed-v1.md](completed-v1.md).

## Overview

Five tasks, three checkpoints. The order is unusual and deliberate: **the test comes first, before
any of the feature it is meant to support.**

- **Phase L — The evidence** (L1–L2): prove what the server actually serves, then fix what that
  proves. Settles [SPEC-local-development.md Open Question 3](../SPEC-local-development.md#open-questions).
- **Phase M — The loop** (L3): `npm run dev` in the generated repo.
- **Phase N — The cliff** (L4–L5): `runway doctor`, then the close-out that keeps the gate and the
  line budget honest.

L4 is parallel with everything — it touches `src/commands/` and `src/cli.ts`, which no other task
opens. L2 and L3 both edit `runway-service-project.ts` and must be sequential.

## Why this order

**1. The serving test comes before the dev loop (L1 first).** The spec's motivating observation is
that no test in any tier asks the server for `/`. The generation test named `serves the built client
from the same process` is a regex over source text. Writing the dev loop first would mean building a
developer convenience on top of a path nobody has ever verified — and worse, the dev loop *routes
around* that path: in development vite serves the client, so a broken `dist/client` serving path
stays invisible in exactly the workflow we are adding. Build the evidence first, while it is still
the point.

**2. L2 may turn out to be empty, and that is a result.** The spec predicts vite's default
`assetsDir` puts bundles at `/assets/index-<hash>.js` while the server resolves by `basename` into
`dist/client/` — a 404 for every asset and a blank page in production. **This is unverified.** If L1
proves it, L2 fixes it. If L1 disproves it, L2 closes as a no-op and the prediction gets struck from
the spec. Either outcome is progress; only leaving it unknown is not.

**3. L1 must not pay for a second `npm install`.** The build-out test already scaffolds into a temp
dir and runs a real `npm install && npx projen && npm run build` under a 600-second timeout. A
standalone serving test that installs again would roughly double the slowest thing in the PR gate.
L1 extends that existing fixture rather than creating a parallel one — the client is already built
by the time it finishes.

**4. `doctor` is independent of all of it (L4).** It diagnoses the machine, not the repo. It shares
no file with L1–L3, so it can be built at any point; it is placed late only because the dev loop is
the thing that was asked for.

**5. The budget is measured before L3, not after.** Criterion 7 caps generated human-read lines at
300 and was already raised once, from 200, to pay for the React client. `isHumanRead` excludes
`vite.config.ts`, so the proxy config is free — but the README lines for `dev` are not. If the
headroom is not there, that conversation happens before code rather than in review.

## Dependency graph

```
L1  Prove what the server serves (LD-09)      ◄── the evidence everything else rests on
 │
 ▼
L2  Fix what L1 exposes  (may be a no-op)
 │
 ▼
L3  The dev loop: concurrently, node --watch, vite proxy  (LD-01…07)
 │
 ▼
L5  Close out: budget, gate, README, file tree

L4  runway doctor (LD-08)  ── parallel with all of the above
```

**L4 is the only safely parallel task.** L1 creates a new test file; L2, L3 and L5 all edit
`packages/runway-cli/src/templates/runway-service-project.ts`, so they serialise on it.

## Checkpoints

- **Checkpoint 1 — after L2.** `/` and every asset it references return 200, proven by fetch, and
  the test fails when `build.outDir` is redirected. Open Question 3 is answered in the spec, either
  way.
- **Checkpoint 2 — after L3.** `npm run dev` in a freshly generated repo serves the app at one
  printed URL with no credential; `npm run build` still passes and still exits.
- **Checkpoint 3 — after L4 and L5.** `runway doctor` names a missing registry credential with its
  fix; the generated file tree is unchanged; criterion 7 still holds with the delta stated.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| **The asset-path prediction is wrong, and L1 finds the serving path fine.** Then L2 is empty and the spec's motivating example was mistaken. | Low — the test is the deliverable either way | The spec already labels it a prediction, not a fact, and says it was not run. L1 settles it; the spec gets corrected in the same commit. |
| **L1 makes the PR gate materially slower.** The build-out test is already the slowest thing in it. | Medium | L1 extends the existing temp-dir fixture rather than installing a second time. If it still costs more than ~20s, say so in the PR rather than absorbing it silently. |
| **Criterion 7 has no headroom left**, and `dev` cannot be documented in the generated README. | Medium — forces a budget decision mid-task | Measured in L3's first acceptance criterion, before any line is written. `vite.config.ts` is uncounted, so the proxy is free; only README and `src/` lines cost. A third raise must be argued at least as hard as the raise from 200 to 300 was. |
| **`concurrently` leaves an orphaned server on Ctrl-C**, so the next `npm run dev` fails on a bound port. | Medium — the failure mode is confusing and hits every developer | L3 verifies signal handling by hand: start, Ctrl-C, restart. This is the specific thing `concurrently` was chosen over a shell `&` to get right; if it does not, the choice was wrong and reopens. |
| **Node's type stripping refuses something in `src/server/index.ts`** — an enum, a namespace, a parameter property — so `node --watch` cannot run it. | Low today, higher later | The current server sample uses none of them. But a team will add one eventually and get a confusing runtime error, so L3's README line says the dev server strips types rather than compiling them. |
| **The dev loop hides the production serving path**, since vite serves the client in development. A team could develop happily for weeks against a `dist/client` path that is broken. | High — this is the exact failure the feature could institutionalise | L1 runs in the PR gate on every commit, against the built output, not the dev server. That is why it is first and why it is blocking. |
| **Open Question 2 (`/api` prefix) is decided implicitly during L3** by whoever writes the proxy line. | Medium — retrofitting a path convention breaks every repo already generated | Called out in L3's acceptance criteria as a decision requiring an answer, not a default. Blocks L3's completion, nothing earlier. |

## Definition of Done

Per task, on top of its own acceptance criteria:

- [ ] Acceptance criteria met by running it, not by typechecking
- [ ] `npm run build`, `npm test`, `npm run lint` pass at the root across all packages
- [ ] **Every negative assertion is failure-injected.** A serving test that cannot fail on a broken
      build is not evidence — the same rule that caught four silent passes in C5–D6
- [ ] No test requires GCP credentials or network beyond the npm registry
- [ ] Generated line count stated in the PR when the scaffold changes, not discovered in review
- [ ] Human review before the task is checked off

## Open Questions

1. ~~**How do two processes run under one `npm run dev`?**~~ **RESOLVED — `concurrently`**, approved
   2026-08-26. Recorded in [SPEC-local-development.md](../SPEC-local-development.md#tech-stack) and
   in [SPEC-runway-cli.md](../SPEC-runway-cli.md#what-the-generated-service-depends-on) as the fifth
   dependency that spec required to be argued separately.
2. ~~**Is `/api/*` reserved for server routes?**~~ **RESOLVED — reserved**, approved 2026-08-26.
   The dev proxy forwards `/api` and `/healthz` to the Node server; everything else is the client.
3. ~~**Does the asset-path prediction hold?**~~ **RESOLVED — it held.** Every built asset 404'd. L2
   was real work, not a no-op.
4. ~~**How much criterion-7 headroom is left?**~~ **RESOLVED — 92 lines** at the end of L3
   (208/300). Measured at 175 before any work; L2 cost 14 and L3 cost 19.
5. **Does anything still assume `__dirname` in generated source?** L3 removed the one occurrence
   after `node --watch` crashed on it — Node loads the `.ts` server as an ES module. Nothing else in
   the scaffold uses it today, but nothing prevents it being reintroduced either. A lint rule or a
   generation assertion would; neither exists. **Does not block L4 or L5.**
