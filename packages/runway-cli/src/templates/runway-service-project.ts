import { resolve } from "node:path";
import { JsonFile, SampleFile, javascript, typescript } from "projen";

/**
 * Everything the generated repo needs in order to run its own first command.
 *
 * TypeScript 7 is the native compiler and exposes no JS compiler API. Two tools
 * this scaffold would otherwise inherit break on that, and both failures are
 * fatal rather than cosmetic:
 *
 *   - ts-node throws (`ts.sys` is undefined), so projen's default projenrc
 *     runner cannot load. `npx projen` would fail outright in the generated
 *     repo. Node's own type stripping needs no compiler API.
 *   - typescript-eslint refuses to install alongside TS 7 (peer range caps at
 *     `<6.1.0`), so `npm install` would fail ERESOLVE. oxlint parses TypeScript
 *     with its own Rust parser instead.
 *
 * See SPEC.md for the full account.
 */
const NODE_VERSION = "22.18.0";
const TYPESCRIPT_VERSION = "7.0.2";
const VITEST = "vitest@4.1.11";
const OXLINT = "oxlint@1.80.0";
const OXLINT_TSGOLINT = "oxlint-tsgolint@7.0.2001";

export interface RunwayServiceProjectOptions {
  /** Service name. Becomes the package name and the repository directory. */
  readonly name: string;

  /** Directory to generate into. @default - a directory named after the service */
  readonly outdir?: string;

  /**
   * How the generated repo resolves `@runway/cli` to regenerate itself.
   *
   * Defaults to a `file:` link at the package that produced the scaffold, which
   * is what makes the emitted repo buildable before `@runway/cli` is published.
   * Swapping this for an exact published version is the one change release
   * requires.
   */
  readonly runwayCliVersion?: string;
}

/**
 * A minimal, projen-managed repository for a new GCP service.
 *
 * Minimal is a hard constraint: every generated line is a line someone must
 * read. If a file is not needed to build, test, or lint, it is not generated.
 */
export class RunwayServiceProject extends typescript.TypeScriptProject {
  constructor(options: RunwayServiceProjectOptions) {
    const runwayCli = options.runwayCliVersion ?? `file:${cliPackageRoot()}`;

    super({
      name: options.name,
      outdir: options.outdir ?? options.name,
      defaultReleaseBranch: "main",
      packageManager: javascript.NodePackageManager.NPM,
      minNodeVersion: NODE_VERSION,
      typescriptVersion: TYPESCRIPT_VERSION,

      projenrcTs: true,
      // Node's own type stripping, because ts-node cannot load TypeScript 7.
      projenrcTsOptions: { runner: typescript.TypeScriptRunner.nodejs() },

      // vitest over jest, and oxlint over eslint, matching the platform.
      jest: false,
      eslint: false,
      devDeps: [VITEST, OXLINT, OXLINT_TSGOLINT, `@runway/cli@${runwayCli}`],

      // One workflow, running the repo's own `build` task — which chains
      // compile, test and lint, so a single job gates all three.
      //
      // Everything else projen would add is switched off deliberately. Left on,
      // a TypeScriptProject also emits a release workflow, a dependency-upgrade
      // workflow, a PR linter, a mergify config and a PR template: five files
      // nobody asked for, in a scaffold whose whole premise is that every
      // generated line is one someone must read.
      github: true,
      githubOptions: { mergify: false, pullRequestLint: false },
      pullRequestTemplate: false,
      depsUpgrade: false,
      release: false,

      workflowNodeVersion: NODE_VERSION,
      workflowPackageCache: true,
      buildWorkflowOptions: {
        // projen defaults to pull_request + workflow_dispatch. With release
        // off, nothing would then verify main after a merge.
        workflowTriggers: {
          pullRequest: {},
          push: { branches: ["main"] },
          workflowDispatch: {},
        },
      },

      licensed: false,
      sampleCode: false,

      // projen's default readme component would otherwise claim README.md with
      // "# replace this", and a SampleFile cannot displace it.
      readme: { contents: renderReadme(options.name) },
    });

    this.testTask.exec("vitest run", { receiveArgs: true });
    this.addLintTasks();
    this.addOxlintConfig();
    this.addSampleCode(runwayCli);
  }

  /** projen has no oxlint component, so the tasks are registered by hand. */
  private addLintTasks(): void {
    const lint = this.addTask("lint", {
      description: "Lint with oxlint, type-aware; warnings fail the build",
      exec: "oxlint --type-aware --deny-warnings",
    });
    this.addTask("lint:fix", {
      description: "Lint with oxlint and autofix what is fixable",
      exec: "oxlint --type-aware --fix",
    });
    this.testTask.spawn(lint);
  }

  private addOxlintConfig(): void {
    new JsonFile(this, ".oxlintrc.json", {
      // oxlint rejects unknown config fields, including projen's "//" marker.
      marker: false,
      obj: {
        $schema:
          "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
        categories: { correctness: "error", suspicious: "warn" },
        rules: { "typescript/no-explicit-any": "error" },
        overrides: [{ files: [".projenrc.ts"], rules: { "no-new": "off" } }],
        ignorePatterns: ["lib/", "node_modules/"],
      },
    });
  }

  /**
   * Emitted as sample files, not managed files: these are the service's own
   * code and the one config it is meant to hand-edit, so projen writes them
   * once and never overwrites them.
   */
  private addSampleCode(runwayCli: string): void {
    new SampleFile(this, ".projenrc.ts", {
      contents: [
        `import { RunwayServiceProject } from "@runway/cli";`,
        "",
        "const project = new RunwayServiceProject({",
        `  name: "${this.name}",`,
        `  runwayCliVersion: "${runwayCli}",`,
        "  // This repo *is* the project. Without it, regenerating would create",
        "  // a nested copy in a subdirectory named after the service.",
        `  outdir: ".",`,
        "});",
        "",
        "project.synth();",
        "",
      ].join("\n"),
    });

    new SampleFile(this, "src/index.ts", {
      contents: [
        `import { createServer } from "node:http";`,
        "",
        "/** Cloud Run supplies PORT; 8080 is its default. */",
        "const port = Number(process.env.PORT ?? 8080);",
        "",
        "export const server = createServer((req, res) => {",
        `  if (req.url === "/healthz") {`,
        `    res.writeHead(200, { "content-type": "application/json" });`,
        `    res.end(JSON.stringify({ status: "ok" }));`,
        "    return;",
        "  }",
        "  res.writeHead(404).end();",
        "});",
        "",
        "if (process.env.NODE_ENV !== \"test\") {",
        "  server.listen(port);",
        "}",
        "",
      ].join("\n"),
    });

    new SampleFile(this, "test/index.test.ts", {
      contents: [
        `import { describe, expect, it } from "vitest";`,
        `import { server } from "../src";`,
        "",
        `describe("health endpoint", () => {`,
        `  it("reports ok", async () => {`,
        "    await new Promise<void>((resolve) => server.listen(0, resolve));",
        "    const address = server.address();",
        `    if (address === null || typeof address === "string") {`,
        `      throw new Error("expected a TCP address");`,
        "    }",
        "",
        "    const response = await fetch(",
        "      `http://127.0.0.1:${address.port}/healthz`,",
        "    );",
        "",
        "    expect(response.status).toBe(200);",
        `    expect(await response.json()).toEqual({ status: "ok" });`,
        "",
        "    server.close();",
        "  });",
        "});",
        "",
      ].join("\n"),
    });
  }
}

/**
 * Absolute path to this package, for the generated repo's `file:` dependency.
 *
 * `__dirname`, not `import.meta.url`: this package compiles to CommonJS, where
 * `import.meta` is a syntax error. The depth is the same from `src/templates/`
 * and `lib/templates/`, so it resolves correctly under both vitest and the
 * built output.
 */
const cliPackageRoot = (): string => resolve(__dirname, "../..");

/** What this is, how to run it, and where the guardrails live. */
const renderReadme = (name: string): string =>
  [
    `# ${name}`,
    "",
    "A GCP service repository scaffolded by `@runway/cli`.",
    "",
    "## Commands",
    "",
    "```bash",
    "npm install        # must precede projen: .projenrc.ts imports it",
    "npx projen         # regenerate config after editing .projenrc.ts",
    "npm run build      # compile, then test, then lint",
    "npm test",
    "npm run lint       # oxlint, type-aware; warnings fail the build",
    "npm run lint:fix",
    "```",
    "",
    "## Where the guardrails live",
    "",
    "`.projenrc.ts` is the only config meant to be hand-edited. Everything else",
    "is generated, and `npx projen` will overwrite it. The defaults come from",
    "`@runway/cli`, so bumping that version moves this repo onto the current",
    "paved road instead of leaving it to drift.",
    "",
    "The toolchain is pinned deliberately. TypeScript 7 is the native compiler",
    "and exposes no JavaScript compiler API, so this repo runs `.projenrc.ts`",
    "through Node's own type stripping and lints with oxlint rather than ESLint —",
    "neither ts-node nor typescript-eslint can load under it.",
    "",
  ].join("\n");
