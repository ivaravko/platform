# Spec: runway-cli

Module `runway-cli` of the [Platform capability map](SPEC.md#capability-map). **Build second — depends on `gcp-components`.**
Shared toolchain, code style, and boundaries are inherited from [SPEC.md](SPEC.md).

Feature specs scoped to this module: [SPEC-local-development.md](SPEC-local-development.md) — the
generated repo's `dev` loop and `runway doctor`.

## Objective

A CLI that scaffolds a minimal, projen-managed git repository for a new GCP service — build, test,
lint, CI, and a deployable hardened infra stack — so a team's first commit is already correct.

**"Minimal" is a hard constraint, not a soft preference — but the floor moved.** The generated
service is a React single-page app served by a Node process: one component, one route, one health
endpoint. It still contains no business logic, no sample REST API, no database layer and no
Dockerfile full of commented-out options. Every generated line is a line someone must read, and a
scaffold that generates 2,000 lines gets deleted and hand-rolled.

What changed is what "the smallest thing that deploys" is *for*. A bare health endpoint proved the
paved road and taught a team nothing about the shape their service would take; a SPA and its server
demonstrate the arrangement most services here will actually have. That is worth roughly sixty
generated lines, and [criterion 7](#success-criteria) is raised deliberately to pay for it rather
than quietly stretched.

**One container, not two.** The Node process serves the built client and the API from the same
image, so the stack `infra/` already provisions is unchanged: one Cloud Run service, one artifact.
Serving the SPA from a bucket behind a load balancer is the more conventional production shape and
would need `gcp-components` that do not exist — a second deployable is a larger change than a
different `src/`.

**Why projen rather than a template repo or `degit`.** A template repo forks and freezes on day
one. projen keeps generated config regenerable: platform ships a new project-type version, the
consumer runs `npx projen`, and CI, lint config, and tsconfig update in place. The generated repo
stays on the paved road instead of drifting off it in month two.

## Scaffold Output

`runway new <service-name>` produces:

```
<service-name>/
├─ .projenrc.ts              → Declares the RunwayServiceProject type; the only config to hand-edit
├─ .github/workflows/        → Generated CI: build, test, lint, pulumi preview on PR
├─ index.html                → Vite entry for the client bundle
├─ src/
│  ├─ client/
│  │  ├─ main.tsx            → Mounts the app; nothing else
│  │  └─ App.tsx             → One component, one heading
│  └─ server/
│     └─ index.ts            → Serves the built client, plus /healthz
├─ test/
│  ├─ App.test.tsx           → One passing component test
│  └─ server.test.ts         → One passing server test
├─ vite.config.ts            → Client build; shares its config with vitest
├─ infra/
│  ├─ Pulumi.yaml
│  ├─ tsconfig.json          → infra/ sits outside srcdir, so `compile` never sees it
│  └─ index.ts               → Composes gcp-components; no raw provider resources
├─ Dockerfile                → Distroless, non-root, multi-stage
└─ README.md                 → What this is, how to deploy, where the guardrails live
```

**Scaffolded repos pin TypeScript 7, matching the platform.** This reverses an earlier decision to
pin 5. The argument for 5 was that a service team should not inherit choices the platform made for
itself; the argument for 7, which won, is that one compiler across platform and scaffold is one set
of behaviours to understand — and a generated repo that compiles differently from the components it
consumes is its own kind of surprise.

The price is paid in the user's repo. `@pulumi/*` peer-caps TypeScript at `<7`, so a generated repo
ships an `.npmrc` with `legacy-peer-deps=true` and cannot install without it — measured, not
assumed: adding `@runway/gcp-components` to a TypeScript 7 scaffold fails `ERESOLVE`. That disables
peer checking repo-wide in a repository the platform does not own, and the `@pulumi/*` pins are what
compensate.

Two costs the earlier decision cited have since been paid regardless. `infra/` is precompiled with
`typescript: false`, because Pulumi runs stack programs through ts-node and ts-node cannot load
TypeScript 7. And the generated projenrc already runs on Node's own type stripping. Neither is a
consequence of this change.

**`infra/` is typechecked separately, and that is not incidental.** It sits outside `srcdir`, so the
project's `compile` never sees it. Without `infra/tsconfig.json` and the `typecheck` task the
load-bearing artifact would be emitted and never verified — it could be broken TypeScript and the
build would pass. Wiring it up immediately caught TS2742 on the exported stack outputs.

`infra/index.ts` is the load-bearing artifact — it is the worked example of composing
`SecureServiceAccount` + `SecureArtifactRepository` + `SecureContainerService`, and it must be
deployable unmodified.

**This was briefly reframed as "the minimum that deploys" and the reframing was wrong.** The argument
was lifecycle: an identity and a registry are created once, a Cloud Run service changes every
deploy, so the first two belong in the provisioning plane and the stack should take an email and an
image from config. That reasoning is sound in the abstract and lost to a fact about the type.
`SecureContainerService` takes `serviceAccount: SecureServiceAccount` — a component reference, not
an email string. A stack cannot supply one from configuration; it has to construct it. The typed
argument is what makes the default compute service account unreachable, which is the guarantee the
component exists to give, so the type wins and the stack composes all three.

## Commands

**Developing the CLI:**
```bash
npm run build --workspace @runway/cli
npm test --workspace @runway/cli -- --coverage
npm run lint --workspace @runway/cli -- --fix
```

**Using the CLI:**
```bash
runway new <service-name> --gcp-project <id> --region europe-west1
runway new <service-name> --dry-run          # Print the file tree, write nothing
runway doctor                                # Verify node/npm/pulumi/gcloud versions and auth
```

Distribution mechanism is [SPEC.md Open Question 5](SPEC.md#open-questions) — unresolved, and it
changes the entry-point shape. Spec'd here as a standalone `bin` for now.

## What the generated service depends on

| Package | Why |
|---------|-----|
| `react`, `react-dom` | The client |
| `vite` | Client bundle, and `vitest` already shares its config — no second build tool |
| `@vitejs/plugin-react` | JSX transform |
| `happy-dom` | vitest needs a DOM to render a component into |
| `@testing-library/react`, `@testing-library/dom` | Rendering a component in a test; the second is a peer of the first and must be declared |
| `concurrently` | Runs the client and server watchers under one `npm run dev` — projen tasks execute sequentially |

Four runtime and dev additions to a repo that previously had none beyond vitest, which
[SPEC.md](SPEC.md#boundaries) makes ask-first. They were asked for and agreed together with the SPA
itself; adding a fifth is a fresh decision.

**The fifth was made, on 2026-08-26: `concurrently`.** Asked for and agreed on its own terms, as
that sentence required. The alternatives — a shell `&`, two terminals, or a hand-rolled vite plugin
supervising a child process — are recorded with their costs in
[SPEC-local-development.md](SPEC-local-development.md#tech-stack). A sixth remains a fresh decision.

**The TypeScript 7 risk was real enough to check, and it passed.** ts-node broke and
`typescript-eslint` became uninstallable on 7, so react + vite + `@types/react` was verified against
7.0.2 before any of this was built: installs with no peer conflict, `tsc --noEmit` typechecks JSX
cleanly, and `vite build` produces a bundle. Vite transpiles with esbuild and never loads the
compiler API, which is why.

**The DOM environment is set per file, not globally.** `environment: "happy-dom"` in `vite.config.ts`
applies a browser to *every* test, and a browser applies same-origin policy — which blocks the
server test's own `fetch` to `127.0.0.1`. The component test carries a
`// @vitest-environment happy-dom` docblock instead, so the default stays `node`. Found by running a
generated repo's suite, not by reading.

## Project Structure

```
packages/runway-cli/
├─ src/
│  ├─ cli.ts                 → Argument parsing and dispatch only; no logic
│  ├─ commands/
│  │  ├─ new.ts
│  │  └─ doctor.ts
│  ├─ templates/
│  │  └─ runway-service-project.ts  → projen project type, subclasses TypeScriptProject
│  └─ files/                 → Static content emitted into new repos (Dockerfile, README)
└─ test/
```

`RunwayServiceProject` subclasses `projen.typescript.TypeScriptProject` (verified at
`projen/lib/typescript/typescript.d.ts`). It is published as part of `@runway/cli` so the generated
repo's `.projenrc.ts` can import it by name and regenerate itself later.

## Testing Strategy

The one test that matters: **scaffold into a temp directory, then build it for real.** Anything
less proves only that we can write files.

| Level      | What it does                                                              |
|------------|---------------------------------------------------------------------------|
| Unit       | Arg parsing, name validation, version-check logic in `doctor`              |
| Generation | Scaffold to a temp dir; assert exact file tree; assert no TODO placeholders |
| Build-out  | In that temp dir: `npm install && npx projen && npm run build && npm test && npm run lint` — all must pass |
| Contract   | Typecheck the generated `infra/index.ts` against the real `@runway/gcp-components` types |
| Idempotence| Run `npx projen` twice; assert zero diff on the second run                 |

- Build-out tests are slow. Tag them and run on every PR anyway — a scaffold that does not build is
  worthless, and finding that out in CI is the entire point of the module.
- Generated-repo assertions are on the **file tree and build result**, not on file contents
  character-by-character. Snapshotting whole file bodies makes every template tweak a snapshot churn.
- The temp-dir build must not require GCP credentials. `pulumi preview` in the generated repo is
  part of *its* CI, not part of *our* PR gate.

## Boundaries

Inherits [SPEC.md](SPEC.md#boundaries). Module-specific additions:

**Always**
- Keep the generated repo minimal — every new generated file needs a justification in the PR.
- Pin the generated repo's `@runway/gcp-components` dependency to an exact published version.
- Make `runway new` refuse to write into a non-empty directory unless `--force` is passed.

**Ask first**
- Adding any file to the scaffold output.
- Adding a CLI command beyond `new` and `doctor`.
- Changing the generated CI workflow shape.

**Never**
- Generate an `infra/index.ts` that declares raw `gcp.*` resources — it must compose components,
  because the generated stack is the example every team copies.
- Generate commented-out code, `TODO` markers, or "delete this if unused" scaffolding.
- Write outside the target directory, or run `git push` / `pulumi up` on the user's behalf.
- Bake credentials, project IDs, or region defaults into generated source — those come from
  Pulumi config, not from generated literals.

## Success Criteria

1. `runway new demo --gcp-project X --region europe-west1` into an empty dir, then
   `npm install && npx projen && npm run build && npm test && npm run lint` — all pass, no edits.
2. The generated `infra/index.ts` typechecks against real `@runway/gcp-components` types and
   declares zero raw `gcp.*` resources.
3. `pulumi preview` in the generated repo plans exactly three resource groups — service account,
   artifact repository, Cloud Run service — with nothing publicly reachable.
4. Running `npx projen` twice in the generated repo produces zero diff on the second run.
5. `runway new` into a non-empty directory fails with an actionable message and writes nothing.
6. `runway doctor` reports missing or mis-versioned node/npm/pulumi/gcloud with a fix instruction.
7. Total generated line count, excluding lockfiles and generated config, stays under **300** lines.

   **Raised from 200, deliberately.** The scaffold sat at 179 with a bare health endpoint; a React
   client, its entry point, a bundler config and a component test cost roughly sixty more. Two
   hundred was chosen because "a scaffold that generates 2,000 lines gets deleted and hand-rolled",
   and that reasoning survives at 300 — what does not survive is treating the number as immovable
   while adding to the scaffold. The cost of raising it is that the next addition will cite this
   precedent, so the next raise should be argued at least this hard.

## Open Questions

1. **Distribution.** Global npm install, `npx runway`, or projen external project type
   (`npx projen new --from @runway/cli`)? The third is the most projen-native and removes our CLI
   from the critical path entirely — worth considering before building a `bin`. See
   [SPEC.md Open Question 5](SPEC.md#open-questions).
2. **GCP project and region:** CLI flags, interactive prompts, or a `~/.runway/config.toml`?
   Prompts hurt CI use; flags hurt ergonomics. Flags with prompt fallback is my recommendation.
3. **Generated CI provider** — GitHub Actions assumed. Confirm; projen supports GitLab CI too.
4. **Does the scaffold `git init` and make an initial commit,** or leave that to the user?
   Recommendation: `git init` plus one commit, so `npx projen` regeneration has a clean baseline diff.
5. ~~Runtime language of the generated *service*~~ — **Resolved: TypeScript, as a React SPA served
   by a Node process.** See [Scaffold Output](#scaffold-output). A team wanting Python or Go now
   needs a second project type rather than a language parameter, which is a larger change than the
   original question anticipated.
   If teams deploy Python or Go services, the project type needs a language parameter and the
   minimal-scaffold constraint gets meaningfully harder.
