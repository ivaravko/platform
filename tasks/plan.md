# Implementation Plan: runway-cli prototype

Scope cut to a **minimal prototype of the CLI only**. Everything else in
[SPEC.md](../SPEC.md) — the `gcp-components` module, the policy pack, generated infra, Docker,
and `runway doctor` — is out of scope and unplanned. The full-scope plan is parked in
[tasks/archive/](archive/) if it is ever wanted back.

**Phase 2 adds generated GitHub Actions CI** (Tasks 4–5) — build, test, and lint only. See
[Phase 2: Generated CI](#phase-2-generated-ci) below.

Tasks: [tasks/todo.md](todo.md).

## Objective

Prove one mechanism: **a custom projen project type, driven by a CLI, emits a repository that
builds.** If that works, the paved road is viable and the rest of the spec is fill-in. If it does
not, nothing downstream matters.

## Scope

**In:** single package, `RunwayServiceProject` project type, `runway new <name>`, a generated repo
that passes its own build/test/lint unmodified, and one generated GitHub Actions workflow that runs
that same build/test/lint on every PR.

**Out:** monorepo layout, `gcp-components`, `infra/`, Dockerfile, `pulumi preview` in generated CI,
`runway doctor`, `--dry-run`, policy pack, control mapping, line budget, publishing.

**Assumption to correct if wrong:** the prototype has no `infra/` directory. Generating a Pulumi
stack now would mean either raw `gcp.*` resources — teaching exactly the habit the real product
exists to prevent — or waiting on components that do not exist. Neither is worth it to prove
scaffolding works.

## Architecture Decisions

**Toolchain: npm.** [SPEC.md](../SPEC.md#tech-stack) pins npm workspaces `>=10` (dev on `11.16.0`);
the three specs are already updated. npm ships with Node, so the toolchain the plan names is present
on the development machine — pnpm was not. One cost carried knowingly: projen has a
`PnpmWorkspaceConfig` component and **no npm equivalent**, so a monorepo's `workspaces` array must be
hand-wired via `package.addField`. That is documented in SPEC.md and does not touch this prototype,
which is single-package.

**Linter: oxlint, type-aware.** ESLint is unusable here — `typescript-eslint` throws on TS 7 and
its peer range will not even install. oxlint parses TypeScript with its own Rust parser and has zero
runtime dependencies, so the compiler API TS 7 removed is irrelevant to it; type-aware rules come
from `oxlint-tsgolint`, itself built on typescript-go. Both verified against `typescript@7.0.2`.
projen has no oxlint component, so `eslint: false` stays and the lint task is one hand-written
`addTask` in `.projenrc.ts`. The scaffold gets the same treatment, which is why the generated repo
can pin TS 7 *and* keep the lint step its spec advertises.

**One package, not a monorepo.** The monorepo exists to version two modules independently. With
one module there is nothing to coordinate, and projen has no npm-workspaces support at all — it
would be the prototype's largest risk for no prototype-level benefit.

**The build-out check is Task 2's verification, not its own task.** At full scope it earned a
dedicated harness task; here, "scaffold to a temp dir and run its build" is three lines inside the
test that already exists.

**The generated repo links our project type via `file:`.** `@runway/cli` is unpublished, so the
scaffolded `.projenrc.ts` cannot import it by version yet. A `file:` reference is the honest
prototype answer; swapping to a published version is a one-line change later.

## Dependency Graph

```
Task 1  CLI package bootstrap
   └── Task 2  RunwayServiceProject — emits a repo that builds   ◄── the thing being proven
          └── Task 3  runway new — CLI entry point
```

Strictly sequential. Nothing to parallelise at this size.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| TypeScript 7.0.2 shipped days ago; projen 0.103.2 predates it | **High** — blocks Task 1 | Task 1 proves it before anything is built on top. If it fails, stop and report — pinning TS 5.x is a decision, not a workaround to take silently. |
| Generated `.projenrc.ts` must import an unpublished `@runway/cli` | **Medium** — blocks Task 2 | `file:` link during development; note the swap to a published version as prototype debt. |
| Real `npm install` in the build-out test is slow — and npm has no content-addressed store, so this is **worse** than the pnpm plan assumed | **Low** at this size, but the one place the npm switch costs something | One shared temp-dir fixture reused across assertions, warm npm cache. Revisit only if the build-out gate exceeds ~3 min. |

## Definition of Done (prototype)

Deliberately lighter than the full-scope bar — this is a prototype, and saying so is more honest
than pretending it clears a production gate.

- [ ] Acceptance criteria met and verified by running it, not by typechecking
- [ ] `npm run build`, `npm test`, and `npm run lint` pass
- [ ] No `any`, no dead code, no `TODO` markers in generated output
- [ ] Human review before the task is checked off

## Open Questions

1. **Does the prototype need to prove more than scaffolding?** If seeing a Pulumi stack deploy is
   the point, that is a different prototype and needs `gcp-components` first.
2. **Distribution** — a `bin`, `npx`, or a projen external project type? Task 3 assumes a plain
   `bin`, as the cheapest thing that demonstrates the flow. This is prototype-only and does not
   commit the real product.
3. **`git init` and initial commit on scaffold?** Assumed no, for now — one less thing to undo when
   re-running the prototype.

---

# Phase 2: Generated CI

Tasks 4–5. Extends the prototype so the scaffolded repo verifies itself on every pull request
instead of only on the developer's machine.

## Context

[SPEC-runway-cli.md](../SPEC-runway-cli.md#scaffold-output) lists `.github/workflows/` as scaffold
output. The archived plan carried this as Task 17, but that version required `pulumi preview`
against `@runway/gcp-components` — which does not exist and is out of prototype scope.

This phase adds the buildable half of that CI, and only that half. `pulumi preview` and the
CrossGuard policy pack stay out: the prototype emits no `infra/` for them to plan against.

**Outcome:** `runway new demo` produces a repo whose CI is green on its first PR, with no workflow
YAML written by hand and no GCP credentials involved.

## Architecture Decisions

**1. Build, test, and lint only — no `pulumi preview`.** Adding it now means either widening the
prototype to include `gcp-components`, or emitting a placeholder — and
[SPEC-runway-cli.md](../SPEC-runway-cli.md#boundaries) forbids generating commented-out code or
`TODO` markers. Deferred, not dropped; archived Task 17 holds its acceptance criteria.

**2. projen's native `buildWorkflow`, not hand-authored YAML.** projen already emits correct npm
bootstrapping — `actions/setup-node@v6` with `cache: "npm"`, then the install
(`projen/lib/javascript/node-project.js:613-660`). Under npm there is no separate package-manager
setup action: the `pnpm/action-setup@v5` step projen adds for PNPM has no npm counterpart, so the
job is one step shorter.
Hand-authoring means re-implementing that and maintaining it forever; projen-native means a
`@runway/cli` version bump propagates workflow improvements to every consumer via `npx projen`,
which is the whole argument for projen in the module spec.

One consequence to accept deliberately: projen's default `TypeScriptProject` also emits a release
workflow, a dependency-upgrade workflow, a PR linter, a mergify config, and a PR template. All are
noise against the minimality constraint, so `RunwayServiceProject` disables each one explicitly. The
emitted `.github/` tree must be exactly one file, and that is asserted rather than reviewed.

**3. Keep projen's self-mutation job.** `mutableBuild` defaults to `true`, adding a second
`self-mutation` job that commits regenerated projen output back to the PR branch. Two consequences
the generated README must state, because they are otherwise invisible:

- It checks out with `${{ secrets.PROJEN_GITHUB_TOKEN }}` (`projen/lib/github/github.js:62`,
  `build-workflow.js:249-283`). A repo without that secret gets a silently failing job, not a
  helpful error.
- It is gated on `NOT_FORK`, so it never runs on fork PRs. Fork contributors see the stale-output
  failure instead of an auto-fix.

A secret *reference* is not a baked credential, so this stays within
[SPEC.md](../SPEC.md#boundaries). Documenting it is Task 5's job.

**4. Trigger on pushes to `main` as well as pull requests.** projen's default is `pull_request` +
`workflow_dispatch` (`build-workflow.js:83-86`). With `release: false` nothing would then verify
`main` after a merge. `buildWorkflowOptions.workflowTriggers` closes that in one line.

**5. Validate emitted YAML by parsing it, not with `actionlint`.** `actionlint` is not installed and
adding a Go binary to the PR gate is a bigger decision than this phase should make. The gate parses
the YAML and asserts structure — job names, triggers, step order, action refs. Run `actionlint` as a
bonus when present on `PATH`; skip when absent rather than fail.

## Dependency Graph

```
Task 2  RunwayServiceProject — emits a repo that builds
   ├── Task 3  runway new — CLI entry point            ─┐ independent,
   └── Task 4  Emit the CI workflow                     │ may run in
          └── Task 5  Workflow contract and validation ─┘ parallel
```

Tasks 4–5 attach to Task 2, not Task 3: the workflow is a property of the project type, and nothing
about it depends on how the CLI is invoked. Tasks 3 and 4 touch disjoint files.

**Task 2 needs one amendment.** Its "exact emitted file tree, no extra files" criterion becomes
false the moment Task 4 adds `.github/workflows/build.yml`. Task 4 updates that assertion — it is
not a Task 4 regression.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| projen defaults to **yarn**, not npm, when `packageManager` is unset (`node-package.js:249-252`) — omitting it silently yields a `yarn.lock` | Medium — would invalidate every build-out verification | Task 1 asserts `packageManager: NodePackageManager.NPM` explicitly. |
| projen emits five extra GitHub files by default; missing one disable leaves noise in a scaffold with a 200-line budget | Medium | The "exactly one file under `.github/`" assertion is the gate. It fails loudly when a projen upgrade adds a new default. |
| Local projen is **0.101.32**; [SPEC.md](../SPEC.md#tech-stack) pins **0.103.2**. All API findings above were verified against 0.101.32. | Medium | Re-verify `buildWorkflowOptions`, `githubOptions`, and `renderWorkflowSetup` against 0.103.2 as the first step of Task 4. Option names are stable across this range; default action versions may not be. |
| `actionlint` absent, so no schema-level YAML validation | Low | Parse-and-assert covers shape. Real proof is a green run on a pushed repo, which is outside the prototype. |
| Self-mutation silently no-ops without `PROJEN_GITHUB_TOKEN` | Low | Task 5 documents it; the README assertion keeps it documented. |

## Open Questions (Phase 2)

4. **Does the prototype need a scaffolded repo pushed to real GitHub to count as proven?** Everything
   planned verifies the workflow's *shape* offline. Nothing proves GitHub accepts and runs it. If
   that proof is wanted, it is a manual step, not a PR-gate test.
5. **Should the platform repo get its own CI in the same pass?** This phase covers only the CI the
   CLI *generates*. `@runway/cli`'s own build/test/lint workflow remains unplanned.
6. **`pulumi preview` re-entry point.** Archived Task 17 is its spec. It returns with
   `gcp-components` — confirm at the Phase 2 checkpoint rather than assuming.
