import { JsonFile, TextFile, javascript, typescript } from "projen";

/**
 * Single source of truth for all generated config. Never hand-edit a generated
 * file — edit this and run `npx projen`.
 *
 * An npm-workspaces monorepo: a private root that owns the toolchain, and one
 * subproject per publishable package under packages/. See tasks/plan.md.
 */

const NODE_VERSION = "22.18.0";
const TYPESCRIPT_VERSION = "7.0.2";
const VITEST = "vitest@4.1.11";
// SPEC.md sets an 80% line-coverage floor per package, and three spec files
// document `-- --coverage`. Without this the flag fails MISSING DEPENDENCY.
const VITEST_COVERAGE = "@vitest/coverage-v8@4.1.11";
const WORKSPACE_GLOB = "packages/*";

// Exact pins, per SPEC.md: caret ranges are for dev tooling only. With
// legacy-peer-deps disabling npm's own compatibility check (see .npmrc below),
// these pins are what holds the verified combination in place.
const PULUMI = "@pulumi/pulumi@3.259.0";
const PULUMI_GCP = "@pulumi/gcp@9.35.1";

/**
 * Shared by the root and every subproject.
 *
 * TypeScript 7 is the native compiler: it exposes no JS compiler API, so
 * ts-node (projen's default projenrc runner) cannot load it, and ESLint is
 * unusable entirely. oxlint parses TypeScript with its own Rust parser and
 * needs no compiler API. See SPEC.md.
 */
const common = {
  defaultReleaseBranch: "main",
  packageManager: javascript.NodePackageManager.NPM,
  minNodeVersion: NODE_VERSION,
  typescriptVersion: TYPESCRIPT_VERSION,
  jest: false,
  eslint: false,
  github: false,
  release: false,
  sampleCode: false,
} as const;

const root = new typescript.TypeScriptProject({
  ...common,
  name: "platform",
  description:
    "Paved road onto GCP: secure-by-default Pulumi components and the CLI that scaffolds services onto them.",
  projenrcTs: true,
  // Node's own type stripping needs no compiler API, unlike ts-node.
  projenrcTsOptions: { runner: typescript.TypeScriptRunner.nodejs() },
  devDeps: [VITEST, VITEST_COVERAGE, "oxlint@1.80.0", "oxlint-tsgolint@7.0.2001"],
  // The root holds only repo-level invariant tests; there is no src/ to compile.
  // rootDir must widen to "." to match: projen defaults it to srcdir, which
  // would make `tsc --noEmit` at the root fail TS6059 on its own test files.
  tsconfig: {
    include: ["test/**/*.ts"],
    compilerOptions: { rootDir: "." },
  },
});

// projen ships PnpmWorkspaceConfig and no npm equivalent, so this is the escape
// hatch — and nothing in projen maintains it. test/workspaces.test.ts is the
// alarm for a projen upgrade silently dropping it.
root.package.addField("private", true);
root.package.addField("workspaces", [WORKSPACE_GLOB]);

const cli = new typescript.TypeScriptProject({
  ...common,
  parent: root,
  outdir: "packages/runway-cli",
  name: "@runway/cli",
  description:
    "Scaffolds a minimal, projen-managed repository for a new GCP service.",
  bin: { runway: "lib/cli.js" },
  devDeps: [VITEST, VITEST_COVERAGE],
});

/**
 * Registers a typecheck task covering the test tree.
 *
 * `compile` only typechecks `src`, so until this existed a type error in a test
 * file was invisible to the whole pipeline — vitest transpiles without checking
 * types, and nothing else looked. Wiring it up immediately surfaced a bad cast
 * that had been sitting in the C4 tests since they were written.
 */
const addTypecheckTask = (
  project: typescript.TypeScriptProject,
  tsconfig: string,
): void => {
  const typecheck = project.addTask("typecheck", {
    description: "Typecheck the test tree; compile only covers src",
    exec: `tsc --noEmit -p ${tsconfig}`,
  });
  project.testTask.spawn(typecheck);
};

/**
 * Registers the lint tasks for a project. projen has no oxlint component, so
 * this is hand-wired.
 *
 * --deny-warnings is what makes `lint` a gate: without it oxlint reports and
 * exits 0. lint:fix deliberately omits it, so autofixing is not also a failure.
 *
 * No -c flag is needed in subprojects: oxlint discovers .oxlintrc.json by
 * walking up from the working directory, so the single root config governs
 * every package.
 */
const addLintTasks = (project: typescript.TypeScriptProject) => {
  const lint = project.addTask("lint", {
    description: "Lint with oxlint, type-aware; warnings fail the build",
    exec: "oxlint --type-aware --deny-warnings",
  });
  project.addTask("lint:fix", {
    description: "Lint with oxlint and autofix what is fixable",
    exec: "oxlint --type-aware --fix",
  });
  return lint;
};

// --- runway-cli -------------------------------------------------------------
// receiveArgs, or `npm test --workspace @runway/cli -- --coverage` silently
// drops the flag: projen accepts the argument and never forwards it to vitest,
// so the command reports success having ignored what was asked for.
cli.testTask.exec("vitest run", { receiveArgs: true });
addTypecheckTask(cli, "test/tsconfig.json");
addLintTasks(cli);

// --- root -------------------------------------------------------------------
// The root compiles nothing itself; it fans out. Left as-is, tsc would fail
// with "No inputs were found" because there is no src/.
root.compileTask.reset("npm run compile --workspaces --if-present");
// Nothing to package: the root is private and publishes no artifact.
root.packageTask.reset();

// Root tests are repo-level invariants only (--dir test), then every workspace
// runs its own suite. Without --dir, vitest would also collect packages/**,
// running each package's tests twice.
root.testTask.reset("vitest run --dir test");
root.testTask.exec("npm run test --workspaces --if-present");
// The root's compile is reset to fan out, so its own tsc never runs and its
// test tree would go unchecked like the packages' did. Root tsconfig already
// includes test/**.
addTypecheckTask(root, "tsconfig.json");
const rootLint = addLintTasks(root);
// One oxlint pass from the root covers every package, so `npm test` at the top
// level gates on lint across the whole repo.
root.testTask.spawn(rootLint);

/**
 * The Pulumi component library. Declared before runway-cli in the capability
 * map: `runway new` is only worth shipping if the repo it emits deploys.
 */
const gcpComponents = new typescript.TypeScriptProject({
  ...common,
  parent: root,
  outdir: "packages/gcp-components",
  name: "@runway/gcp-components",
  description:
    "Secure-by-default Pulumi ComponentResources for GCP. Every insecure configuration requires a named, justified opt-out.",
  // peerDeps, not deps. Two copies of @pulumi/pulumi in one program break
  // resource registration, and a published library that bundles its own copy
  // makes that the consumer's problem. projen also pins them as devDeps
  // (peerDependencyOptions.pinnedDevDependency), so tests still resolve them.
  peerDeps: [PULUMI, PULUMI_GCP],
  devDeps: [VITEST, VITEST_COVERAGE],
});

gcpComponents.testTask.exec("vitest run", { receiveArgs: true });
addTypecheckTask(gcpComponents, "test/tsconfig.json");
addLintTasks(gcpComponents);

/**
 * `npm install` fails outright without this.
 *
 * The file is generated rather than hand-written, but unlike every other
 * generated file here it carries its own explanation: someone hitting an
 * ERESOLVE failure reads .npmrc, not .projenrc.ts.
 */
new TextFile(root, ".npmrc", {
  lines: [
    "# ~~ Generated by projen. To modify, edit .projenrc.ts and run \"npx projen\".",
    "#",
    "# @pulumi/pulumi declares peerDependencies typescript \">= 3.8.3 < 7\", and this",
    "# repo is on TypeScript 7. A plain `npm install` therefore fails ERESOLVE.",
    "# Both of its peers (typescript, ts-node) are marked optional, so nothing",
    "# needs them at runtime -- the range is stale metadata, not a real constraint.",
    "#",
    "# The cost is real and accepted: this disables peer checking for the WHOLE",
    "# repo, so a genuinely incompatible peer elsewhere will now install silently.",
    "# The @pulumi/* versions are pinned exactly and asserted in tests, which is",
    "# what replaces the check this removes.",
    "legacy-peer-deps=true",
    "",
  ],
});

new JsonFile(root, ".oxlintrc.json", {
  // oxlint rejects unknown config fields, including projen's "//" marker.
  // The file is still projen-owned — see .projen/files.json.
  marker: false,
  obj: {
    $schema:
      "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
    // correctness and suspicious gate the build. pedantic is deliberately off:
    // it includes rules like prefer-readonly-parameter-types that would block on
    // style rather than defects.
    categories: { correctness: "error", suspicious: "warn" },
    // Mirrors SPEC.md Code Style: no `any`, and no non-null assertions outside tests.
    rules: {
      "typescript/no-explicit-any": "error",
      "typescript/no-non-null-assertion": "error",
    },
    overrides: [
      {
        // Tests read JSON this repo generates itself. Asserting its shape is a
        // cast at a trusted boundary; runtime type guards would add ceremony,
        // not safety.
        files: ["**/test/**/*.ts"],
        rules: {
          "typescript/no-non-null-assertion": "off",
          "typescript/no-unsafe-type-assertion": "off",
        },
      },
      {
        // `new JsonFile(project, ...)` is projen's idiom — a construct registers
        // itself with its parent in the constructor. The return value is meant
        // to be discarded.
        files: [".projenrc.ts"],
        rules: { "no-new": "off" },
      },
    ],
    ignorePatterns: ["lib/", "node_modules/", "packages/*/lib/"],
  },
});

// .claude/worktrees/ is where EnterWorktree puts isolated checkouts. Untracked,
// it would show up in `git status` and break the clean-tree checks each task runs.
root.gitignore.exclude("dist/", ".tmp-scaffold/", ".claude/worktrees/");

root.synth();
