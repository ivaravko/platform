# Tasks: runway-cli prototype

Six tasks, two checkpoints. Rationale and scope boundary: [tasks/plan.md](plan.md).
Everything outside the CLI scaffolding mechanism and its generated CI is out of scope.

- **Phase 1 — Scaffolding** (Tasks 1, 1b, 2, 3): prove a projen project type driven by a CLI emits
  a repo that builds and lints.
- **Phase 2 — Generated CI** (Tasks 4–5): that repo verifies itself on every PR. Build, test, and
  lint only; `pulumi preview` is deferred with `gcp-components`.

Tasks 3 and 4 are independent and may run in parallel once Task 2 is green.

---

## Phase 1: Scaffolding

### ✅ Task 1: Bootstrap the CLI package — DONE
A single projen-managed TypeScript package. Not a monorepo — there is only one module in scope.

**Acceptance criteria**
- [x] `.projenrc.ts` declares one `typescript.TypeScriptProject` with a `bin` entry
- [x] `packageManager: NodePackageManager.NPM` is set **explicitly** — projen falls back to
      `YARN_CLASSIC` with a deprecation warning when the option is omitted
      (`projen/lib/javascript/node-package.js:249-252`), so silence yields a `yarn.lock`
- [x] TypeScript 7.0.2 and vitest 4.1.11 resolve and run — **if projen cannot drive TS 7, stop and report rather than silently pinning TS 5.x**
      → **Reported and resolved by decision.** TS 7 is the native compiler and exposes no JS
      compiler API, which breaks ts-node and typescript-eslint. `tsc` and vitest are unaffected.
      Chosen: keep TS 7 and run `.projenrc.ts` via `TypeScriptRunner.nodejs()`. ESLint was dropped
      ([typescript-eslint#10940](https://github.com/typescript-eslint/typescript-eslint/issues/10940))
      and is **superseded by oxlint in Task 1b** — waiting on typescript-eslint is no longer needed.
- [x] `.gitignore` covers `node_modules/`, `dist/`, and temp scaffold output

**Verification**
- [x] `npm install && npx projen && npm run build && npm test` passes from a clean clone.
      **Install comes first** — `npx projen` executes `.projenrc.ts`, which imports `projen`, so it
      cannot run before `node_modules` exists. No lint step at the time this task shipped —
      the linter arrives in Task 1b.
- [x] `npx projen` twice produces zero diff on the second run (`git diff --exit-code`)
- [x] `package-lock.json` is generated and no `yarn.lock` or `pnpm-lock.yaml` appears

**Dependencies:** None
**Files:** `.projenrc.ts`, `.gitignore` (+ projen-generated `package.json`, `tsconfig.json`)
**Scope:** S — carries the plan's only high risk

---

### Task 1b: Wire Oxlint into the platform package
Restores the lint gate that TypeScript 7 took away. Separate from Task 1 because Task 1 shipped
without a linter and is already committed — this is the follow-up that closes it.

**Acceptance criteria**
- [ ] `.projenrc.ts` registers a `lint` task running `oxlint --type-aware --deny-warnings`, and a
      `lint:fix` variant with `--fix`; `eslint: false` stays (projen has no oxlint component)
- [ ] `oxlint@1.80.0` and `oxlint-tsgolint@7.0.2001` are pinned devDeps
- [ ] `--deny-warnings` is present, so a warning fails the build rather than printing a report
- [ ] `.oxlintrc.json` is projen-generated, not hand-written — it is config, and the repo's rule is
      that projen owns config

**Verification**
- [ ] `npm run lint` exits 0 on the current tree
- [ ] Introducing an unused variable makes `npm run lint` exit non-zero, and removing it restores 0
      — proves the gate actually gates
- [ ] A floating promise is caught, proving `--type-aware` is live and not silently syntax-only
- [ ] `npm install && npx projen && npm run build && npm test && npm run lint` passes from a clean clone
- [ ] `npx projen` twice still produces zero diff

**Dependencies:** Task 1
**Files:** `.projenrc.ts`, `.oxlintrc.json` (generated), `test/toolchain.test.ts` (assert the pins)
**Scope:** S

---

### Task 2: `RunwayServiceProject` — emit a repo that builds
The mechanism the prototype exists to prove. A custom projen project type that emits the minimum
buildable repository.

**Acceptance criteria**
- [ ] `RunwayServiceProject` subclasses `projen.typescript.TypeScriptProject` and is exported
- [ ] Emits `.projenrc.ts`, `src/index.ts` (health endpoint only), `test/index.test.ts` (one passing test), `README.md`
- [ ] Emits an oxlint setup matching the platform's — `eslint: false`, a `lint` task, pinned
      `oxlint`/`oxlint-tsgolint`, and a generated `.oxlintrc.json`. This is what lets the scaffold
      pin TS 7 and still honour the "build, test, lint" output its spec advertises.
- [ ] Generated `.projenrc.ts` resolves `@runway/cli` via `file:` link so the repo can regenerate itself
- [ ] No `TODO` markers, commented-out code, or placeholder scaffolding in emitted files

**Verification**
- [ ] Test scaffolds into a temp dir and runs `npm install && npx projen && npm run build && npm test && npm run lint` — all pass unmodified
- [ ] Test asserts the exact emitted file tree, no extra files
      — **amended by Task 4**, which adds `.github/workflows/build.yml` to the expected tree
- [ ] `grep -rE "TODO|FIXME" <scaffold>` returns nothing
- [ ] Temp dir cleaned up on both pass and fail

**Dependencies:** Task 1
**Files:** `src/templates/runway-service-project.ts`, `src/index.ts`, `test/runway-service-project.test.ts`
**Scope:** M

---

### Task 3: `runway new` entry point
Wire the project type to a command. Parsing and dispatch only — no scaffolding logic here.

**Acceptance criteria**
- [ ] `runway new <name>` scaffolds via `RunwayServiceProject` into `./<name>`
- [ ] Refuses a non-empty target directory and writes nothing
- [ ] Rejects invalid names, including path traversal, before writing anything
- [ ] `--help` lists the command and its arguments

**Verification**
- [ ] End-to-end test through the CLI binary, not the project type directly; scaffolded repo builds
- [ ] Non-empty-dir test asserts the pre-existing file is byte-identical afterwards
- [ ] Traversal fixture (`../escape`) exits non-zero and writes nothing

**Dependencies:** Task 2
**Files:** `src/cli.ts`, `src/commands/new.ts`, `test/cli.test.ts`
**Scope:** S

---

### ✅ Checkpoint: Scaffolding Proven
- [ ] `runway new demo` produces a repo that builds, tests, and lints unmodified
- [ ] Whole flow runs offline with no GCP credentials
- [ ] **Decide what the prototype proved** — whether the paved-road approach is worth building out,
      and if so, which archived plan phases come back first
- [ ] Human review

---

## Phase 2: Generated CI

The scaffolded repo verifies itself on every pull request instead of only on the developer's
machine. Decisions and risks: [Phase 2 in plan.md](plan.md#phase-2-generated-ci).

---

### Task 4: Emit the CI workflow from `RunwayServiceProject`
Turn on projen's GitHub integration and switch off everything projen would add beyond the build
workflow. One emitted file, running the generated repo's own `build` task — which in projen's
`TypeScriptProject` chains compile → test, and Task 1b's `lint` task joins them, so a single job covers all three.

**Acceptance criteria**
- [ ] `RunwayServiceProject` sets `github: true`, `release: false`, `depsUpgrade: false`,
      `pullRequestTemplate: false`, and `githubOptions: { mergify: false, pullRequestLint: false }`
- [ ] The emitted `.github/` tree is exactly `.github/workflows/build.yml` — no release, upgrade,
      PR-lint, mergify, or PR-template files
- [ ] `workflowNodeVersion` matches the project's `minNodeVersion` (Node 22 per
      [SPEC.md](../SPEC.md#tech-stack)); `workflowPackageCache: true` sets `cache: "npm"`
- [ ] Workflow triggers are `pull_request`, `push` to `main`, and `workflow_dispatch`
- [ ] The emitted job contains **no** package-manager setup action — under npm, projen adds no
      counterpart to the `pnpm/action-setup@v5` step it emits for PNPM
      (`projen/lib/javascript/node-project.js:623-628`)

**Verification**
- [ ] `npm test -- -t "ci workflow"` passes
- [ ] Build-out test (extending Task 2's): scaffold to a temp dir, then
      `npm install && npx projen && npm run build && npm run lint` still passes with the workflow present
- [ ] Test parses the emitted YAML and asserts job `build` exists with steps in order:
      checkout → node setup → install → `npx projen build` — exactly four steps
- [ ] Test asserts `.github/workflows/` contains exactly one entry
- [ ] `npx projen` twice in the scaffold produces zero diff on the second run

**Dependencies:** Task 2
**Files:** `src/templates/runway-service-project.ts`, `test/templates/ci-workflow.test.ts` (new),
`test/runway-service-project.test.ts` (file-tree assertion amended)
**Scope:** S — 3 files, one an amendment

---

### Task 5: Workflow contract — validation, secrets, and the self-mutation caveat
Make explicit the two things a green CI run hides: that the workflow bakes in no credentials, and
that self-mutation needs `PROJEN_GITHUB_TOKEN` and is skipped on fork PRs. Split from Task 4 so
these negative paths are proven rather than appended to a task that already "works".

**Acceptance criteria**
- [ ] Generated `README.md` documents the `PROJEN_GITHUB_TOKEN` repository secret: what it is for,
      what breaks without it, and that self-mutation is skipped on pull requests from forks
- [ ] No literal credential, project ID, region, or token appears anywhere in `.github/` — only
      `${{ secrets.* }}` references
- [ ] Stale projen output fails the build job — verified, not assumed

**Verification**
- [ ] `npm test -- -t "workflow contract"` passes
- [ ] `grep -rE "AIza|-----BEGIN|ghp_|github_pat_|projects/[0-9]+" <scaffold>/.github` returns nothing
- [ ] Test asserts every `secrets.` reference in the emitted YAML is in an allowlist of exactly
      `GITHUB_TOKEN` and `PROJEN_GITHUB_TOKEN` — a new secret cannot appear unnoticed
- [ ] Test asserts the `self-mutation` job carries both the not-a-fork condition and
      `permissions: contents: write`
- [ ] Test asserts the generated README mentions `PROJEN_GITHUB_TOKEN`, so a later template edit
      cannot silently drop the caveat
- [ ] Stale-output check: mutate a projen-managed file in the scaffold, run the build task, assert
      a non-zero exit

**Dependencies:** Task 4
**Files:** `src/files/readme.ts` (wherever Task 2 puts the README template),
`test/templates/workflow-contract.test.ts` (new)
**Scope:** S

---

### ✅ Checkpoint: Generated CI Complete
- [ ] `runway new demo` emits exactly one workflow, and it is the only file under `.github/`
- [ ] The scaffolded repo still builds, tests, and lints unmodified — CI added nothing to fix
- [ ] Whole flow runs offline: no GCP credentials, no network beyond the npm registry
- [ ] `npx projen` remains idempotent in the scaffold
- [ ] `PROJEN_GITHUB_TOKEN` is documented in the generated README, not just known here
- [ ] **Decide whether the deferred `pulumi preview` job returns with `gcp-components`, or whether
      the generated CI shape needs revisiting first** —
      [SPEC-runway-cli.md](../SPEC-runway-cli.md#boundaries) makes workflow shape an ask-first change
- [ ] Human review
