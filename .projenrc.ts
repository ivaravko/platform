import { JsonFile, javascript, typescript } from "projen";

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
const WORKSPACE_GLOB = "packages/*";

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
  devDeps: [VITEST, "oxlint@1.80.0", "oxlint-tsgolint@7.0.2001"],
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
  devDeps: [VITEST],
});

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
cli.testTask.exec("vitest run");
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
const rootLint = addLintTasks(root);
// One oxlint pass from the root covers every package, so `npm test` at the top
// level gates on lint across the whole repo.
root.testTask.spawn(rootLint);

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

root.gitignore.exclude("dist/", ".tmp-scaffold/");

root.synth();
