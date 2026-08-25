import { javascript, typescript } from "projen";

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
  devDeps: ["vitest@4.1.11"],

  // typescript-eslint throws on TS 7 ("does not support TS 7.0") and its peer
  // range caps at <6.1.0, so it cannot even install. Lint returns when
  // typescript-eslint supports TS 7 — typescript-eslint/typescript-eslint#10940.
  eslint: false,

  // Out of prototype scope: the platform's own CI, and publishing.
  github: false,
  release: false,
  sampleCode: false,
});

project.testTask.exec("vitest run");
project.gitignore.exclude("dist/", ".tmp-scaffold/");

project.synth();
