# Spec: runway-cli

Module `runway-cli` of the [Platform capability map](SPEC.md#capability-map). **Build second — depends on `gcp-components`.**
Shared toolchain, code style, and boundaries are inherited from [SPEC.md](SPEC.md).

## Objective

A CLI that scaffolds a minimal, projen-managed git repository for a new GCP service — build, test,
lint, CI, and a deployable hardened infra stack — so a team's first commit is already correct.

**"Minimal" is a hard constraint, not a soft preference.** The generated repo contains the service
skeleton and its infrastructure. It does not contain business logic, a sample REST API, a database
layer, or a Dockerfile full of commented-out options. Every generated line is a line someone must
read, and a scaffold that generates 2,000 lines gets deleted and hand-rolled. If a file is not
needed to build, test, lint, or deploy, it is not generated.

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
├─ src/
│  └─ index.ts               → Minimal HTTP server, health endpoint only
├─ test/
│  └─ index.test.ts          → One passing test, so the suite is green from commit one
├─ infra/
│  ├─ Pulumi.yaml
│  ├─ tsconfig.json          → infra/ sits outside srcdir, so `compile` never sees it
│  └─ index.ts               → Composes gcp-components; no raw provider resources
├─ Dockerfile                → Distroless, non-root, multi-stage
└─ README.md                 → What this is, how to deploy, where the guardrails live
```

**Scaffolded repos pin TypeScript 5, not the platform's 7.** The platform pins 7 and pays for it:
ts-node cannot load, ESLint is unusable, and `@pulumi/*` peer-caps TypeScript at `<7` so every
install needs `legacy-peer-deps`. A scaffolded repo composes those same components, so pinning 7
here would transfer all of it to a service team that never made the choice — an `.npmrc` disabling
peer checks repo-wide, a precompile step for the Pulumi program, and an isolated install before the
policy pack could run. Measured: adding `@runway/gcp-components` to a TypeScript 7 scaffold fails
`ERESOLVE`. On 5 none of that exists, `infra/index.ts` runs directly through ts-node, and the
divergence in compiler version is the price — paid by the platform, which is where the decision was
made.

**`infra/` is typechecked separately, and that is not incidental.** It sits outside `srcdir`, so the
project's `compile` never sees it. Without `infra/tsconfig.json` and the `typecheck` task the
load-bearing artifact would be emitted and never verified — it could be broken TypeScript and the
build would pass. Wiring it up immediately caught TS2742 on the exported stack outputs.

`infra/index.ts` is the load-bearing artifact — it is the worked example of composing
`SecureServiceAccount` + `SecureArtifactRepository` + `SecureContainerService`, and it must be
deployable unmodified.

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
7. Total generated line count, excluding lockfiles and generated config, stays under 200 lines.

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
5. **Runtime language of the generated *service*** — TypeScript assumed, matching the toolchain.
   If teams deploy Python or Go services, the project type needs a language parameter and the
   minimal-scaffold constraint gets meaningfully harder.
