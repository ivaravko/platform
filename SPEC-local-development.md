# Spec: Local development

**A feature of [`runway-cli`](SPEC-runway-cli.md), not a module.** Everything here is emitted by
`RunwayServiceProject` or lives in `src/commands/doctor.ts` — the same project type, the same
generation and build-out test tiers. [SPEC.md](SPEC.md#the-two-environment-modules) sets the test for
a real boundary: a module is one if it could be replaced wholesale without rewriting its neighbours.
This could not be, so it gets a feature spec and no capability-map row. Requirements are numbered
`LD-nn` and referenced by test name, matching the `EP-nn` convention in
[SPEC-environment-provisioning.md](SPEC-environment-provisioning.md).

## Objective

A developer in a `runway new` repository changes a line and sees the result — without a build step,
without a credential, without deploying. And a developer cloning that repository for the first time
gets a diagnosis instead of an npm 401.

**Users**
- *Service developers* — the audience the scaffold exists for. They get a repo that builds, tests,
  lints and deploys, and today no way to look at it running.
- *Platform engineers* — own the template. Every line added here is generated into every service
  repo forever, against a hard budget.

### What is missing today, stated precisely

The generated repo registers `compile` (tsc for the server, `vite build` for the client, tsc for
`infra/`), `test`, `lint`, `build` and `package`. **There is no task that runs the service.** The
only way to see it is a full compile followed by `node lib/server/index.js` — a loop measured in
tens of seconds, with no reload, which nothing in the repo tells you to do.

**And the client path is unproven.** `test/server.test.ts` fetches `/healthz` and nothing else.
`test/App.test.tsx` renders `<App />` into happy-dom and never touches the server. The generation
test named `serves the built client from the same process`
([runway-service-project.test.ts:215](packages/runway-cli/test/templates/runway-service-project.test.ts#L215))
asserts `/dist|client/` against the *source text* of `src/server/index.ts`. It is a grep. No test in
any tier ever asks the server for `/` and checks what comes back.

> **A specific failure this predicted — since confirmed, and fixed.** vite's `build.assetsDir`
> defaults to `assets`, so the built `index.html` references `/assets/index-<hash>.js`. The server
> resolved a request as `basename(requested)` and read `join(clientDir, file)` — deliberately, so a
> crafted URL could not escape the directory — which for that request resolved to
> `dist/client/index-<hash>.js`. That path does not exist, so every asset 404'd and the deployed SPA
> rendered an empty `<div id="root">`.
>
> **Written as an unverified prediction, then run.** It held, exactly as described, on the first
> execution of LD-09:
>
> ```
> AssertionError: expected [ Array(1) ] to deeply equal []
> + [ [ "/assets/index-DpaM2eIG.js", 404 ] ]
> ```
>
> Fixed in L2 by bounding the resolved path to `dist/client` instead of flattening it to a basename,
> so nested asset paths are served and traversal is refused with 403. **The guard was replaced, not
> removed** — see [Boundaries](#boundaries) and the escape-attempt tests.
>
> Worth stating plainly: this shipped, in a repository whose stated premise is that a team's first
> commit is already correct, and the reason nobody noticed is the reason this spec exists. A grep
> stood where a fetch belonged.

This is the argument for the feature in one line: the gap that hides a bug like that is the same gap
that makes the repo unpleasant to work in.

## Scope

| In | Out |
|---|---|
| A `dev` task in the generated repo: client HMR + server restart | Local development of the `platform` repo itself |
| Same-origin dev serving, so client and server share one URL | Running Cloud Run, GCP, or any emulator locally |
| `runway doctor`, covering the first-install failures | Docker-based parity runs (`docker run` of the built image) |
| A test that proves the built client is actually served | Debugger/IDE launch configs |

**Deferred deliberately, with reasons.** Container parity (`docker run` the image CI builds) answers
a different question — does the *image* work — on a loop too slow to develop against. It is worth
specifying once the fast loop exists and once `release-path` has an opinion about who runs images
locally. Platform-repo contributor setup is genuinely a separate audience with separate constraints
(TypeScript 7, `legacy-peer-deps`, the policy-pack install) and would dilute both.

## Requirements

**The dev loop**

- **LD-01** — One command. `npm run dev` in a freshly generated repo starts everything needed and
  prints one URL to open. Not two commands, not two terminals: the scaffold's premise is that a team
  should not have to assemble the obvious.
- **LD-02** — A change to `src/client/**` is visible in the browser without a manual reload and
  without a build step.
- **LD-03** — A change to `src/server/**` restarts the server automatically. No manual step, no
  `tsc` invocation.
- **LD-04** — **One origin.** The browser talks to a single host and port; server routes are reached
  on that same origin. No CORS configuration, no port to remember, and above all **no environment
  variable carrying an API base URL** — that variable is how a dev-only config leaks into production
  code, and the scaffold must not teach it.
- **LD-05** — **After `npm install`, the loop needs no credential, no GCP, and no network.** This is
  [SPEC.md](SPEC.md#boundaries)'s credential-free rule applied to the dev loop rather than the gate.
- **LD-06** — **Exactly one new dev dependency: `concurrently`, and no other.** Agreed under the
  ask-first rule (Open Question 1). Everything else in the loop runs on what the repo already has —
  vite for the client, Node's own type stripping for the server. A second addition is a fresh
  decision, on the same terms this one was.
- **LD-07** — `dev` is **not** reachable from `build`. Nothing in the PR gate starts a watcher, and
  no CI job can hang waiting on one.

**First install**

- **LD-08** — `runway doctor` reports, with a fix instruction for each: Node below `22.18.0`, npm
  below 10, a missing `pulumi` or `gcloud`, and — the one that actually bites — **no Artifact
  Registry credential for `@runway:registry`**. A fresh clone today fails `npm install` with a bare
  npm 401 and no pointer to
  [`npx google-artifactregistry-auth`](packages/runway-cli/src/templates/runway-service-project.ts#L444),
  even though the emitted `.npmrc` explains it three lines above the line that fails.
- **LD-09** — **The served-client path gets a behavioural test.** Build the client, start the server,
  fetch `/`, and assert the response is the SPA document *and that every asset it references
  resolves 200*. Replaces a regex over source text with a fetch.

### The tension in LD-05, resolved rather than hidden

"Fully offline, no credentials" and "first install needs a registry credential" cannot both hold
unqualified — you cannot `npm run dev` without `node_modules`, and `@runway/*` comes from an
authenticated Artifact Registry repository.

The line is **install-time versus loop-time**. Installing is authenticated, once, per machine.
Everything after it — every `dev`, every `test`, every edit — is offline and credential-free. LD-08
exists precisely because that one authenticated step is the whole cliff, and it currently presents
as a 401 with no explanation.

## Tech Stack

One addition, agreed. Everything else is already present or already relied on.

| Concern | Mechanism | Already used for |
|---|---|---|
| Client HMR + dev origin | vite dev server (`vite@^7`, in `CLIENT_DEV`) | `vite build` in `compile:client` |
| Server watch + TS execution | `node --watch`, Node's own type stripping | `.projenrc.ts`, via `TypeScriptRunner.nodejs()` |
| Dev-time routing | vite `server.proxy` | — |
| Running both under one command | **`concurrently` — NEW devDep** | — |

**`concurrently` is the one addition, and it was argued for rather than assumed.** projen tasks
execute their steps sequentially, so LD-01's single command needs a supervisor. The zero-dependency
alternatives each cost more than they save: a shell `&` orphans the server on Ctrl-C, two tasks in
two terminals fails LD-01 outright, and a vite plugin spawning a child process puts fifteen lines of
bespoke process supervision into every service repo forever — in a scaffold whose stated premise is
that nothing clever gets generated. One small, widely-used devDep is the cheaper trade.

Pinned by caret, per [SPEC.md](SPEC.md#tech-stack)'s version policy: exact pins are for `@pulumi/*`,
where a mismatched provider is a real hazard. The generated repo commits a lockfile.

**Type stripping is the load-bearing choice, and it is the same one the repo already made.** ts-node
cannot load under TypeScript 7 (`ts.sys` is undefined), which is why `.projenrc.ts` runs on
`TypeScriptRunner.nodejs()` and why `minNodeVersion` is `22.18.0`. That same Node runs
`src/server/index.ts` directly: no `tsc` in the loop, no ts-node, no dependency. The scaffold's
server uses no enum, no namespace and no parameter property, so nothing type stripping refuses.

**The one honest constraint:** type stripping does not typecheck. `tsc` still runs in `compile` and
in the gate — the dev loop trades checking for speed, which is the trade every dev server makes.

> **A second constraint, found by running it rather than by reading.** Node infers a `.ts` file's
> module system from its syntax, and the server uses `import` — so `node --watch src/server/index.ts`
> loads it as an **ES module**, where `__dirname` does not exist. `tsc` emits CommonJS for `lib/`, so
> the same source worked compiled and crashed in the dev loop:
>
> ```
> ReferenceError: __dirname is not defined in ES module scope
> ```
>
> `import.meta.dirname` is not the fix — it is a syntax error in the CommonJS output the image runs,
> the same trap `cliPackageRoot()` documents in the CLI package. **The client directory is resolved
> from the working directory instead** (`resolve("dist/client")`), which is correct in all four
> contexts that matter: the image (`WORKDIR /app`, with `dist/` beside `lib/`), the dev loop, the
> generated repo's own suite, and LD-09. It also removes the module-system dependency altogether.

**The line budget has a seam worth knowing.** `isHumanRead`
([runway-service-project.test.ts:35](packages/runway-cli/test/templates/runway-service-project.test.ts#L35))
counts `src/**`, `test/*.test.ts`, `README.md`, `.projenrc.ts` and `.oxlintrc.json` toward criterion
7's 300 lines. **`vite.config.ts` is not counted.** So dev-time routing costs nothing against the
budget while a line in `src/server/index.ts` costs one — which is the right pressure, and the reason
this design puts the proxy in vite's config rather than branching inside the server.

Headroom must be measured before implementing, not assumed: the budget is at 300 and the React
client already spent a raise from 200.

## Commands

In a generated repo:

```bash
npm run dev            # vite dev server + `node --watch` server; prints one URL
npm run build          # unchanged: compile → test → lint. Never spawns dev.
npm test               # unchanged
```

In this repo, developing the feature:

```bash
npm install                                              # must precede projen
npm test --workspace @runway/cli -- -t "LD-"             # this feature's tier, offline
npm test --workspace @runway/cli -- -t "line budget"     # criterion 7 headroom
npm run build                                            # the whole PR gate
runway doctor                                            # LD-08, run by hand
```

## Project Structure

Changes are confined to one template file, one CLI command, and their tests.

```
packages/runway-cli/
├─ src/
│  ├─ commands/
│  │  └─ doctor.ts                       → NEW. LD-08. Already in SPEC-runway-cli's structure
│  └─ templates/
│     └─ runway-service-project.ts       → the dev task, the proxy block, README lines
└─ test/
   ├─ commands/doctor.test.ts            → NEW. LD-08, table-driven over version/auth states
   └─ templates/
      ├─ runway-service-project.test.ts  → LD-07 (dev not in build); file-tree list unchanged
      └─ dev-loop.test.ts                → NEW. LD-09, the fetch that replaces the grep
```

**No new file in the generated tree.** The dev task is a `package.json` script, the proxy is four
lines inside the existing `vite.config.ts`, and the README gains a line. The exact-file-tree
assertion at
[runway-service-project.test.ts:60](packages/runway-cli/test/templates/runway-service-project.test.ts#L60)
therefore does not change — which is the outcome to aim for, given "Adding any file to the scaffold
output" is ask-first.

## Code Style

House style: the comment says *why*, and the surprising choice carries its reason inline.

```ts
new SampleFile(this, "vite.config.ts", {
  contents: [
    `import react from "@vitejs/plugin-react";`,
    `import { defineConfig } from "vite";`,
    "",
    "export default defineConfig({",
    "  plugins: [react()],",
    "  // The server serves this directory; keep the two in step.",
    `  build: { outDir: "dist/client" },`,
    "  // One origin in development: vite serves the client and forwards server",
    "  // routes to the Node process. Same-origin here as in production, so no",
    "  // CORS and no API base URL — a dev-only variable that reaches production",
    "  // code is how this goes wrong.",
    `  server: { proxy: { "/healthz": SERVER_ORIGIN } },`,
    "});",
  ].join("\n"),
});
```

```ts
/**
 * The loop the repo previously had no answer for.
 *
 * `node --watch` on the .ts source directly: Node 22.18 strips types itself,
 * and ts-node — the usual answer — cannot load under TypeScript 7 at all. So
 * this needs no compiler in the loop and no dependency that does not exist.
 *
 * Deliberately not spawned by `build` (LD-07): a watcher in the PR gate is a
 * job that never exits.
 */
private addDevTask(): void {
  this.addTask("dev", {
    description: "Run the client and server locally with reload on change.",
    // ...
  });
}
```

**Conventions inherited unchanged** from [SPEC.md](SPEC.md#code-style): named exports only, no
`any`, no non-null assertions outside tests, 2-space indent, 100-column width. Generated content is
emitted as `SampleFile` where the team owns it afterwards and `TextFile` where projen does.

## Testing Strategy

| Level | Proves | Runs | Gate |
|---|---|---|---|
| Unit | `doctor`'s version comparison and auth detection, table-driven (LD-08) | Every PR | Blocking |
| Generation | The `dev` task exists, is not spawned by `build` (LD-07), and the file tree is unchanged | Every PR | Blocking |
| Serve | Build the client, start the server, fetch `/` and its assets (LD-09) | Every PR | Blocking |
| Manual | HMR and server restart actually feel instant (LD-02, LD-03) | On change to the loop | Non-blocking |

- **LD-09 is the test that matters**, for the same reason the build-out test is the one that matters
  in [SPEC-runway-cli.md](SPEC-runway-cli.md#testing-strategy): anything less proves only that we
  wrote a string containing the word `client`. It must assert the referenced assets resolve, not
  merely that `/` returns 200 — a server that returns `index.html` for everything passes the weak
  version of this test while serving a blank page.
- **Failure-injected, per the house pattern.** Point `build.outDir` somewhere else and LD-09 must
  fail. A serving test that cannot fail on a broken build is not evidence.
- **`doctor` is table-driven** over: Node below minimum, Node at minimum, npm below 10, `pulumi`
  absent, `gcloud` absent, no `@runway:registry` credential, and an everything-present case. Each
  asserts the *fix instruction*, not just the failure — a diagnostic a developer cannot act on is
  the failure it was written to prevent.
- **Offline.** Every blocking test here runs with no credential and no network, per
  [SPEC.md](SPEC.md#boundaries). `doctor`'s registry check is unit-tested against injected states;
  it is never exercised against the real registry in the gate.
- **HMR is not automated.** Driving a browser to prove hot reload costs a headless-browser
  dependency in the PR gate to test a developer convenience. Manual, and stated as manual, rather
  than a test that would be quietly disabled the first time it flaked.

## Boundaries

Inherits [SPEC.md](SPEC.md#boundaries) and
[SPEC-runway-cli.md](SPEC-runway-cli.md#boundaries). Feature-specific:

**Always**
- Add the dev loop through `.projenrc.ts` and `RunwayServiceProject`; never hand-edit generated output.
- Measure the criterion-7 line budget before and after — the number goes in the PR description.
- Keep `dev` out of `build`, `compile`, `test` and every CI job.

**Ask first**
- Adding any dependency to the generated repo for the dev loop **beyond `concurrently`**, which is
  agreed. LD-06 caps the loop at that one; a second is a fresh decision, not a detail.
- Adding a file to the generated tree.
- Reserving a URL path prefix in the scaffold (Open Question 2).

**Never**
- Introduce an environment variable holding an API base URL, or any dev-only branch inside
  `src/server/**`. Same-origin in development is what makes both unnecessary (LD-04).
- Weaken the server's `basename` path handling to make the client serve. It is the control that
  stops a crafted URL escaping the client directory; if assets need nested paths, the fix is a
  bounded resolver with its own test, not the removal of the guard.
- Make any blocking test require a credential or the network.
- Let `doctor` mutate anything — it reports and instructs. Same rule as EP-06's audit: a tool that
  repairs what it inspects gets trusted with things it should not have.

## Success Criteria

1. In a freshly generated repo: `npm install && npx projen && npm run dev` serves the app at one
   printed URL, with no further steps and no credential.
2. Editing `src/client/App.tsx` updates the browser without a reload; editing `src/server/index.ts`
   restarts the server. Both without a `tsc` invocation.
3. `npm run build` in that repo passes and exits — the existing build-out test is unchanged and
   still green, proving `dev` did not leak into the gate (LD-07).
4. **LD-09 passes, and fails when `build.outDir` is redirected.** Whichever way the asset-path
   prediction lands, the answer is now proven by a fetch rather than a regex.
5. `runway doctor` on a machine with no Artifact Registry credential names the missing credential and
   prints the `npx google-artifactregistry-auth` command. On a fully configured machine it exits 0.
6. `npm test --workspace @runway/cli` passes offline, with no credential present.
7. Criterion 7 still holds: total generated human-read lines ≤ 300, with the delta stated.
8. The generated file tree is byte-identical in membership to today's — no new file.

## Open Questions

1. ~~**How do two processes run under one `npm run dev`?**~~ **RESOLVED — `concurrently`, as a dev
   dependency of the generated repo.** Approved under the ask-first rule on 2026-08-26. The three
   zero-dependency alternatives and why each costs more are recorded in
   [Tech Stack](#tech-stack); the decision is LD-06.

2. ~~**Is a path prefix reserved for server routes?**~~ **RESOLVED — `/api/*` is reserved**, approved
   2026-08-26. The dev proxy forwards `/api` and `/healthz` to the Node server; everything else is
   the client. Documented in the generated README, asserted by `LD-04`.

3. ~~**Does the prediction in the Objective hold?**~~ **RESOLVED — it held.** `/assets/index-<hash>.js`
   returned 404 on the first run of LD-09; the built SPA served a blank page. Fixed in L2 with a
   resolver bounded to `dist/client`. Both the fix and the bound are asserted by test.

4. ~~**How much criterion-7 headroom is left?**~~ **RESOLVED — 111 lines.** Measured at 175/300
   before the work and 189/300 after L2. The `dev` documentation fits comfortably; no budget
   conversation is needed.

5. **Should path containment follow symlinks?** The L2 resolver bounds the *resolved* path, which
   stops every traversal reachable over HTTP. It does not call `realpath`, so a symlink placed
   inside `dist/client` and pointing outside it would still be served. That is judged out of scope:
   `dist/client` holds vite's output and nothing else, and write access to it is a prior compromise
   of the image. Recorded because it is a real limit of the guard, not an oversight — revisit if
   anything ever writes into that directory at runtime.
