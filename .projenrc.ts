import { JsonFile, javascript, typescript } from "projen";

/**
 * Single source of truth for all generated config. Never hand-edit a generated
 * file — edit this and run `npx projen`.
 *
 * One package, not a monorepo: the prototype has a single module, and projen has
 * no npm-workspaces component to lean on. See tasks/plan.md.
 */
const project = new typescript.TypeScriptProject({
  name: "@runway/cli",
  description:
    "Scaffolds a minimal, projen-managed repository for a new GCP service.",
  defaultReleaseBranch: "main",

  // Explicit: projen falls back to yarn with a deprecation warning when this is
  // unset, which would silently produce a yarn.lock.
  packageManager: javascript.NodePackageManager.NPM,
  projenrcTs: true,
  // TypeScript 7 is the native compiler: it exposes no JS compiler API, so
  // ts-node (projen's default runner) cannot load it. Node's own type stripping
  // needs no compiler API at all.
  projenrcTsOptions: { runner: typescript.TypeScriptRunner.nodejs() },
  minNodeVersion: "22.18.0",
  typescriptVersion: "7.0.2",

  bin: { runway: "lib/cli.js" },

  // vitest, not projen's default jest.
  jest: false,

  // oxlint replaces ESLint: typescript-eslint throws on TS 7 and its peer range
  // caps at <6.1.0, so it cannot install. oxlint parses TypeScript with its own
  // Rust parser and needs no compiler API; oxlint-tsgolint adds type-aware rules
  // and is itself built on typescript-go. projen has no oxlint component, so the
  // task below is registered by hand.
  eslint: false,
  devDeps: ["vitest@4.1.11", "oxlint@1.80.0", "oxlint-tsgolint@7.0.2001"],

  // Out of prototype scope: the platform's own CI, and publishing.
  github: false,
  release: false,
  sampleCode: false,
});

project.testTask.exec("vitest run");

// --deny-warnings is what makes this a gate: without it oxlint reports and
// exits 0. lint:fix deliberately omits it so autofix is not also a failure.
const lint = project.addTask("lint", {
  description: "Lint with oxlint, type-aware; warnings fail the build",
  exec: "oxlint --type-aware --deny-warnings",
});
project.addTask("lint:fix", {
  description: "Lint with oxlint and autofix what is fixable",
  exec: "oxlint --type-aware --fix",
});
project.testTask.spawn(lint);

new JsonFile(project, ".oxlintrc.json", {
  // oxlint rejects unknown config fields, including projen's "//" marker.
  // The file is still projen-owned — see .projen/files.json.
  marker: false,
  obj: {
    $schema: "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
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
        files: ["test/**/*.ts"],
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
    ignorePatterns: ["lib/", "node_modules/"],
  },
});

project.gitignore.exclude("dist/", ".tmp-scaffold/");

project.synth();
