# Tasks: local-development

Five tasks, three checkpoints. Rationale, dependency graph and risks:
[tasks/local-development-plan.md](local-development-plan.md).
Spec: [SPEC-local-development.md](../SPEC-local-development.md), requirements `LD-01`–`LD-09`.
Completed history: [tasks/completed-v1.md](completed-v1.md).

**This list carries its own tasks, like [integration-tests-plan.md](integration-tests-plan.md) does.**
`tasks/todo.md` stays with `environment-provisioning`, which is the active module and progressing —
E1–E4 landed on `main` while this feature was built.

**All five tasks are complete.** See the checkpoint blocks for what was verified and how.

- **Phase L — The evidence** (L1–L2): prove what the server actually serves, then fix what that
  proves.
- **Phase M — The loop** (L3): `npm run dev`.
- **Phase N — The cliff** (L4–L5): `runway doctor`, and the close-out that keeps the gate honest.

L4 is parallel with everything — it is the only task that opens no file another task touches.
L2, L3 and L5 all edit `runway-service-project.ts` and must run in order.

---

## Phase L: The evidence

### L1: Prove what the server actually serves
The one gap the whole feature rests on. No test in any tier asks the generated server for `/`. The
generation test named `serves the built client from the same process` asserts `/dist|client/`
against the **source text** of `src/server/index.ts` — it is a grep, and it passes whether or not a
single byte is ever served.

**Acceptance criteria**
- [x] Against a **built** scaffold, fetch `/` and assert the response is the SPA document — the
      `index.html` vite emitted, not merely a 200
- [x] **Every asset the document references is fetched and asserted 200.** A server that returns
      `index.html` for every path passes the weak version of this test while serving a blank page,
      so the assertion is on the referenced URLs, parsed out of the document
- [x] `/healthz` still returns `{"status":"ok"}` — the existing behaviour is not disturbed
- [x] Extends the existing build-out temp-dir fixture rather than running a second `npm install`
- [x] Replaces the source-text grep at `runway-service-project.test.ts:215`, which is deleted in the
      same commit — a weaker test left beside a stronger one gets cited as coverage

**Verification**
- [x] **Failure-injected**: redirect `build.outDir` away from `dist/client` and the test fails.
      An absence proven against injected presence, not asserted alone
- [x] Failure-injected the second way: serve `index.html` for every request and the asset assertion
      still fails
- [x] `npm test --workspace @runway/cli -- -t "LD-09"` passes, offline, no credential
- [x] The added wall-clock cost of the gate is measured and stated in the PR

**Dependencies:** None
**Files:** `packages/runway-cli/test/templates/runway-service-project.test.ts`
**Scope:** M

> **Deviation from plan, and why.** The plan put these assertions in a new `dev-loop.test.ts`.
> Vitest runs each test *file* in its own worker, so a separate file would have meant a second
> `npm install` — the exact cost the plan forbade. They live in the build-out file instead, sharing
> its fixture, which was hoisted into a `beforeAll` so the built repo is prepared once.
>
> **Result: the gate cost +0.3s**, measured — 14.6s to 14.9s for the file. The install was already
> being paid; only the server start and eight fetches are new.

---

### L2: Fix what L1 exposes
**Not empty — the prediction held.** L1's first run returned `["/assets/index-DpaM2eIG.js", 404]`:
vite's default `assetsDir` emits `/assets/index-<hash>.js`, the server reduced that to
`basename(...)` and read `dist/client/index-<hash>.js`, which does not exist. Every asset 404'd and
the built SPA rendered a blank `<div id="root">` — in production, on the current `main`.

**Acceptance criteria**
- [x] If L1 fails: `/` and every referenced asset serve correctly, and L1 goes green **without its
      assertions being weakened**
- [x] **The `basename` guard is not removed.** Replaced, not deleted: the path is resolved against
      `clientDir` and refused with 403 if it lands outside. Nested asset paths now serve; traversal
      still cannot. Asserted by three escape-attempt cases, not assumed
- [~] ~~If L1 passes: close as a no-op~~ — **not applicable, L1 failed.** The prediction was
      confirmed rather than struck
- [x] Either outcome is recorded in [SPEC-local-development.md](../SPEC-local-development.md)
      Open Question 3, resolved — recorded as **held**, with the failing assertion quoted

**Verification**
- [x] **Failure-injected**: `/..%2f..%2fpackage.json`, `/%2e%2e%2f%2e%2e%2fpackage.json` and
      `/assets%2f..%2f..%2fpackage.json` each return **403 exactly** — not merely "not 200", which a
      coincidental 404 would satisfy
- [!] **A symlinked path was NOT tested, deliberately.** The resolver bounds the resolved path, not
      the real path, so a symlink inside `dist/client` pointing outward would still be served.
      Judged out of scope — that directory holds vite output only, and write access to it is a prior
      compromise. Recorded as a real limit of the guard in
      [Open Question 5](../SPEC-local-development.md#open-questions), not silently skipped
- [x] L1's own failure injection still fails the suite
- [x] `npm run build` at the root passes

**Dependencies:** L1
**Files:** `packages/runway-cli/src/templates/runway-service-project.ts`,
`packages/runway-cli/test/templates/runway-service-project.test.ts`, `SPEC-local-development.md`
**Scope:** S if L1 passes, M if it does not — **it did not; M**

> **Checkpoint 1 — MET.** 8 LD-09 assertions pass; the asset test failed before the fix and passes
> after; traversal returns 403 on all three encoded forms. Full gate green, exit 0: 165 + 107 tests,
> typecheck and `oxlint --type-aware --deny-warnings`. Generated line budget 189/300 (+14),
> headroom 111. Open Question 3 resolved as **held**; Open Question 4 resolved at 111 lines.

---

## Phase M: The loop

### L3: `npm run dev`
The thing that was asked for. One command, client HMR, server restart, one origin.

**Acceptance criteria**
- [x] **First, before writing anything: measure the criterion-7 headroom** and record it. If the
      README lines for `dev` do not fit in 300, stop and raise it as a budget decision — a third
      raise is argued, not spent. **Measured: 189/300, headroom 111.** No budget conversation needed
- [x] `npm run dev` in a freshly generated repo starts both watchers and prints **one** URL (LD-01)
- [~] A change to `src/client/**` reaches the browser with no reload and no build (LD-02).
      **Partially verified.** The vite dev server serves the client and injects the react-refresh
      runtime — confirmed in the served document — so the HMR machinery is present and active. A
      browser was not driven to observe an actual hot update. The spec already classes this as a
      manual, non-blocking check; recorded here rather than claimed
- [x] A change to `src/server/**` restarts the server, with no `tsc` in the loop (LD-03) — via
      `node --watch` on the `.ts` source, using Node's own type stripping, the same mechanism
      `.projenrc.ts` already relies on because ts-node cannot load under TypeScript 7
- [x] **One origin** (LD-04): server routes are proxied through the vite dev server. No CORS config,
      and **no environment variable holding an API base URL** — that variable is how a dev-only
      value reaches production code
- [x] `concurrently` is the **only** new dependency (LD-06)
- [x] The proxy block lives in `vite.config.ts`, which `isHumanRead` does not count — the server is
      not branched on `NODE_ENV` to achieve the same thing
- [x] **Open Question 2 is answered before this task closes**: is `/api/*` reserved? A one-route
      proxy list is a decision about every repo generated afterwards
- [x] The generated README gains a `dev` line that says types are **stripped, not checked**, so the
      first confusing runtime error has an explanation nearby

**Verification**
- [x] `npm test --workspace @runway/cli -- -t "LD-07"`: `dev` exists as a task and is **not**
      reachable from `build`, `compile` or `test`. A watcher in the PR gate is a job that never exits
- [x] The build-out test still passes unchanged — `npm run build` in a generated repo still exits
- [x] **By hand, and recorded in the PR**: start `dev`, Ctrl-C, start it again. No orphaned process,
      no bound port. This is the specific thing `concurrently` was chosen over a shell `&` to get
      right; if it does not, the choice reopens
- [x] By hand: edit the client, then the server, and confirm LD-02 and LD-03 without a rebuild
- [x] Line-count delta stated in the PR

**Dependencies:** L2
**Files:** `packages/runway-cli/src/templates/runway-service-project.ts`,
`packages/runway-cli/test/templates/runway-service-project.test.ts`
**Scope:** M

> **Checkpoint 2 — MET, and it found a second bug.** Verified against a real generated repo, not
> asserted:
>
> ```
> http://localhost:5173/          → the SPA, with the react-refresh runtime injected
> http://localhost:5173/healthz   → {"status":"ok"} [200]   proxied to the Node server
> http://localhost:5173/api/*     → 404 from the Node server, not the client
> touch src/server/index.ts       → 1 restart logged by node --watch
> SIGINT to the process group     → 0 listeners on 8080, 0 on 5173, 0 surviving processes
> ```
>
> **The bug: `node --watch` crashed on `__dirname`.** Node infers the module system from the file's
> syntax, and the server uses `import`, so the dev loop loads it as an ES module where `__dirname`
> does not exist — while `tsc` emits CommonJS for `lib/`, so the same source worked compiled. Fixed
> by resolving the client directory from the working directory instead, which is correct in the
> image (`WORKDIR /app`), the dev loop, the generated suite and LD-09 alike.
>
> **This is the second production-path defect the feature has surfaced, and neither was visible to
> the gate.** The first was found by writing a test; this one only by running the thing.
>
> Full gate green, exit 0: 109 tests, typecheck, `oxlint --type-aware --deny-warnings`. Budget
> 208/300 (+19 for L3), headroom 92. `concurrently --kill-others` handles Ctrl-C cleanly — the
> reason it was chosen over a shell `&` holds up.

---

## Phase N: The cliff

### L4: `runway doctor`
The first-run failure nobody currently gets told about. A fresh clone fails `npm install` with a
bare npm 401, three lines below an `.npmrc` comment that explains exactly how to fix it.

Specified in [SPEC-runway-cli.md](../SPEC-runway-cli.md#project-structure) since the module was
written, never built.

**Acceptance criteria**
- [x] Reports, each with a **fix instruction**: Node below `22.18.0`, npm below 10, `pulumi` absent,
      `gcloud` absent, and no Artifact Registry credential for `@runway:registry`
- [x] The registry case prints the `npx google-artifactregistry-auth --credential-config=$HOME/.npmrc`
      command — the one the emitted `.npmrc` already documents
- [x] Exits non-zero when anything is missing, 0 when all present
- [x] **`doctor` never mutates anything.** It reports and instructs. Same rule as EP-06's audit: a
      tool that repairs what it inspects gets trusted with things it should not have
- [x] Wired into `src/cli.ts` dispatch; `runway --help` lists it

**Verification**
- [x] Table-driven over: Node below minimum, Node exactly at minimum, npm below 10, `pulumi` absent,
      `gcloud` absent, no registry credential, and everything present
- [x] **Each case asserts the fix instruction, not just the failure.** A diagnostic a developer
      cannot act on is the failure this task exists to prevent
- [x] **Failure-injected**: a fully configured machine reports clean, then one credential is removed
      and the same check fires
- [x] Structurally asserted that nothing in the command writes: no `writeFile`, no `execFile` of a
      mutating command
- [x] `npm test --workspace @runway/cli -- -t "LD-08"` passes offline, with no credential present —
      the registry check is unit-tested against injected states, never against the real registry

**Dependencies:** None — parallel with L1–L3
**Files:** `packages/runway-cli/src/commands/doctor.ts` (new),
`packages/runway-cli/src/cli.ts`, `packages/runway-cli/test/commands/doctor.test.ts` (new)
**Scope:** M

---

### L5: Close out
The assertions that stop this feature quietly costing something later.

**Acceptance criteria**
- [x] The generated file tree is **identical in membership** to before the feature: no new file.
      The exact-tree assertion is unchanged, which is the evidence
- [x] Criterion 7 holds — human-read lines ≤ 300 — with the before/after delta in the PR
- [x] `SPEC-local-development.md` open questions are all resolved or explicitly carried, with
      reasons; none left ambiguous
- [x] The generated README documents `dev` in the same voice as the rest of it, no TODO markers
- [x] `README.md` at the repo root: the "Not built yet" list drops `runway doctor` and gains nothing
      false — it currently claims no `runway doctor` exists, which L4 makes stale

**Verification**
- [x] `npm run build` at the root: compile → test → lint, all packages, offline, credential-free
- [x] The full build-out test passes, including the second-synth idempotence check
- [x] `npm test --workspace @runway/cli -- -t "line budget"` passes and the number is stated
- [x] `npm test --workspace @runway/cli -- -t "emits exactly the expected files"` passes unchanged

**Dependencies:** L3, L4
**Files:** `packages/runway-cli/src/templates/runway-service-project.ts`,
`packages/runway-cli/test/templates/runway-service-project.test.ts`, `README.md`,
`SPEC-local-development.md`
**Scope:** S

> **Checkpoint 3 — MET.** `runway doctor` run for real on this machine:
>
> ```
> ok    Node 26.3.0 (need >= 22.18.0)
> ok    npm 11.16.0 (need >= 10.0.0)
> ok    Pulumi CLI 3.246.0
> ok    gcloud 581.0.0
> FAIL  Artifact Registry credential for @runway missing
>       Authenticate once, into your own ~/.npmrc — never into a repo, which would commit the token:
>         npx google-artifactregistry-auth --credential-config=$HOME/.npmrc
>       Without it, npm install in a generated repo fails with a bare 401.
>
> 1 of 5 checks failed.                                                      exit 1
> ```
>
> It found a genuine gap rather than reporting all-clear, which is the outcome that proves the check
> is wired to something real.
>
> Full gate green, exit 0: **137 tests** (up from 104), typecheck, `oxlint --type-aware
> --deny-warnings`. Generated file tree unchanged — no new file. Budget **208/300**, headroom 92:
> 175 at the start, +14 for L2's resolver, +19 for L3's README and dev documentation.
