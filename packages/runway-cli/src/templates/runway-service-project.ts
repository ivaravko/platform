import { resolve } from "node:path";
import { JsonFile, SampleFile, TextFile, javascript, typescript } from "projen";

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
/**
 * **Scaffolded repos use TypeScript 7, matching the platform.**
 *
 * This reverses an earlier decision to pin 5 here. The argument for 5 was that
 * a service team should not inherit choices the platform made for itself; the
 * argument for 7 is that one compiler across platform and scaffold is one set
 * of behaviours to understand, and a generated repo that compiles differently
 * from the components it consumes is its own kind of surprise.
 *
 * It is not free. `@pulumi/*` peer-caps TypeScript at `<7`, so a generated repo
 * cannot `npm install` without the `.npmrc` below, which disables peer checking
 * repo-wide — in a repository the platform does not own. That is the price of
 * the match, and it is paid in the user's repo rather than ours.
 *
 * Two costs the earlier comment listed have since been paid anyway: `infra/` is
 * already precompiled with `typescript: false` (Pulumi cannot run TypeScript 7
 * through ts-node), and the projenrc already runs on Node's own type stripping.
 */
const TYPESCRIPT_VERSION = "7.0.2";

/** Pinned exactly, matching the platform's own `@pulumi/*` pins. */
const PULUMI = "@pulumi/pulumi@3.259.0";
const PULUMI_GCP = "@pulumi/gcp@9.35.1";
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

      // The components the infra program composes. A `file:` link while
      // @runway/gcp-components is unpublished; D7 swaps it for a version.
      deps: [PULUMI, PULUMI_GCP, `@runway/gcp-components@${componentsPackage()}`],

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
    this.addNpmrc();
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

  /**
   * Without this a generated repo cannot install at all.
   *
   * Generated rather than hand-written, but unlike every other generated file
   * it carries its own explanation: someone hitting ERESOLVE reads .npmrc, not
   * the project type that produced it.
   */
  private addNpmrc(): void {
    new TextFile(this, ".npmrc", {
      lines: [
        "# ~~ Generated by projen. To modify, edit .projenrc.ts and run \"npx projen\".",
        "#",
        "# @pulumi/pulumi declares peerDependencies typescript \">= 3.8.3 < 7\", and this",
        "# repo is on TypeScript 7. A plain `npm install` therefore fails ERESOLVE.",
        "# Both of its peers (typescript, ts-node) are marked optional, so nothing",
        "# needs them at runtime -- the range is stale metadata, not a real constraint.",
        "#",
        "# The cost is real: this disables peer checking for the WHOLE repo, so a",
        "# genuinely incompatible peer elsewhere will now install silently. The",
        "# @pulumi/* versions are pinned exactly to compensate.",
        "legacy-peer-deps=true",
        "",
      ],
    });
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

    // The load-bearing artifact: a worked example of composing all three
    // components.
    //
    // **Precompiled, and `typescript: false` is not optional.** Pulumi runs a
    // .ts program through ts-node with type checking on, which here means
    // type-checking the whole @pulumi/gcp declaration graph on every single
    // invocation -- measured at over two minutes without completing, on both
    // Pulumi's vendored ts-node 7 and a current ts-node 10. Compiled, the same
    // preview finishes in seconds.
    new SampleFile(this, "infra/Pulumi.yaml", {
      contents: [
        `name: ${this.name}`,
        `description: Infrastructure for ${this.name}, composed from @runway/gcp-components.`,
        "runtime:",
        "  name: nodejs",
        "  options:",
        "    # This does NOT disable TypeScript. index.ts is the stack program and",
        "    # stays TypeScript; the flag only tells Pulumi not to transpile it",
        "    # itself. `npm run build` compiles infra/ with tsc and Pulumi runs the",
        "    # output named by `main` below.",
        "    #",
        "    # Required, not preferred: Pulumi transpiles via ts-node, which cannot",
        "    # load TypeScript 7 at all, and which type-checks the whole @pulumi/gcp",
        "    # declaration graph on every invocation -- measured at over two minutes",
        "    # without finishing. Compiled, the same preview takes seconds.",
        "    typescript: false",
        "main: lib/index.js",
        "",
      ].join("\n"),
    });

    new SampleFile(this, "infra/index.ts", {
      contents: renderInfra(this.name),
    });

    // infra/ sits outside srcdir, so the project's `compile` never sees it.
    // This gives it its own compile, which both produces what Pulumi runs and
    // typechecks it -- without this the artifact the spec calls load-bearing
    // could be broken TypeScript and the build would still pass.
    new JsonFile(this, "infra/tsconfig.json", {
      marker: false,
      obj: {
        extends: "../tsconfig.json",
        compilerOptions: {
          rootDir: ".",
          outDir: "lib",
          types: ["node"],
        },
        include: ["*.ts"],
        exclude: ["lib"],
      },
    });

    const compileInfra = this.addTask("compile:infra", {
      description: "Compile the infra program; Pulumi runs the output, not the source",
      exec: "tsc -p infra/tsconfig.json",
    });
    this.compileTask.spawn(compileInfra);

    this.gitignore.exclude("infra/lib/");

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

/**
 * `file:` reference to the components package.
 *
 * Unpublished, so a version range cannot resolve yet. Swapping this for a
 * published version is a one-line change and is D7's job.
 */
const componentsPackage = (): string =>
  `file:${resolve(cliPackageRoot(), "../gcp-components")}`;

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
    "## CI",
    "",
    "`.github/workflows/build.yml` runs the same `build` task on every pull",
    "request and on pushes to `main`, so CI and your machine cannot disagree.",
    "",
    "If `build` changes any generated file, the run fails — that means the",
    "committed output is stale and `npx projen` was not run. A second job,",
    "`self-mutation`, repairs that automatically by committing the regenerated",
    "files back to the pull request. **It needs a `PROJEN_GITHUB_TOKEN` secret**",
    "with permission to push to the branch. Two things to know:",
    "",
    "- Without that secret the self-mutation job fails rather than fixing",
    "  anything, and the stale output stays stale. Add it, or run `npx projen`",
    "  and commit the result yourself.",
    "- It is skipped on pull requests from forks, which cannot be pushed to.",
    "  Fork contributors see the failure and must run `npx projen` themselves.",
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

/**
 * The worked example. Composes all three components and declares no raw
 * `gcp.*` resource — the scaffold must not teach the habit the product exists
 * to prevent.
 */
const renderInfra = (name: string): string =>
  [
    'import * as pulumi from "@pulumi/pulumi";',
    'import {',
    "  SecureArtifactRepository,",
    "  SecureContainerService,",
    "  SecureServiceAccount,",
    '} from "@runway/gcp-components";',
    "",
    "// Named gcpConfig rather than gcp, so nothing in this file reads as the",
    "// provider namespace. A reader checking that the scaffold declares no raw",
    "// resource should be able to grep for it and find nothing.",
    'const gcpConfig = new pulumi.Config("gcp");',
    'const project = gcpConfig.require("project");',
    "// Required, not defaulted. An unset region would otherwise deploy this",
    "// service somewhere nobody chose, silently; `require` makes it stop.",
    'const location = gcpConfig.require("region");',
    "",
    "// Tags are immutable: a pushed tag can never be repointed. Release by",
    "// pushing a NEW tag rather than moving an existing one -- `latest` would",
    "// work exactly once.",
    'const imageTag = new pulumi.Config().get("imageTag") ?? "v1";',
    "",
    'const images = new SecureArtifactRepository("images", {',
    `  repositoryId: "${name}",`,
    "  location,",
    "  project,",
    "});",
    "",
    "// Starts with no roles at all. Grant what this service needs, one at a",
    "// time; project-wide and administrative roles are rejected outright.",
    'const identity = new SecureServiceAccount("runtime", {',
    `  accountId: "${name}",`,
    "  project,",
    "});",
    "",
    "// Private by default: internal load-balancer ingress, no invoker binding,",
    "// deletion protection on. Reaching it needs a load balancer, which is the",
    "// secure default working rather than a misconfiguration.",
    `const service = new SecureContainerService("${name}", {`,
    "  location,",
    "  image: pulumi.interpolate`${images.imagePrefix}/" + name + ":${imageTag}`,",
    "  serviceAccount: identity,",
    "});",
    "",
    "// Annotated explicitly. Without it TypeScript cannot name the inferred",
    "// Output type portably (TS2742) when the components package resolves",
    "// through a link -- and an exported stack output should say its type.",
    "export const serviceName: pulumi.Output<string> = service.service.name;",
    "export const imageRepository: pulumi.Output<string> = images.imagePrefix;",
    "export const runtimeIdentity: pulumi.Output<string> = identity.email;",
    "",
  ].join("\n");
