import { JsonFile, TextFile, github, javascript, typescript } from "projen";

const { JobPermission } = github.workflows;

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
// Needed by the CrossGuard policy pack. peerDep for the same reason as the
// others: the pack ships inside this package and must not bundle a second copy.
const PULUMI_POLICY = "@pulumi/policy@1.21.0";

/**
 * TypeScript for the policy pack's own isolated install. **Deliberately not the
 * repo's TypeScript 7 — aligning them breaks the pack.**
 *
 * Pulumi's policy-pack runner hardcodes ts-node on
 * (`cmd/run-policy-pack/index.js:110`) and ignores `PulumiPolicy.yaml`, so
 * `typescript: false` does nothing there. It then resolves `typescript` from
 * `@pulumi/pulumi`'s location and only falls back to its vendored 3.8.3 if that
 * `require` *throws*. TypeScript 7 imports fine but exposes no compiler API, so
 * the fallback never fires and ts-node dies on `ts.sys.readFile`.
 *
 * What the pack actually needs is that **the nearest resolvable `typescript`
 * has a compiler API** — not, as first thought, that no `typescript` resolves
 * at all. That earlier framing was a location-dependent accident: it held only
 * while the pack happened to sit outside any tree containing TypeScript.
 */
const POLICY_TYPESCRIPT = "typescript@5.9.3";

/**
 * Where the pack is installed for use. Outside `node_modules/`, so `npm ci`
 * does not delete it — installing into `node_modules` and then mutating it was
 * measured to be wiped by the first clean install, which is what CI runs.
 */
const POLICY_DIR = ".runway-policy";

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

/**
 * projen defaults the lib to es2020, older than the runtime this repo already
 * requires. Node 22.18 implements ES2023, and oxlint's `no-array-sort` steers
 * to `toSorted()` — an ES2023 method the es2020 lib does not declare — so the
 * linter and the typechecker contradicted each other until these were aligned.
 *
 * Spread into each project's `compilerOptions` rather than set in `common`,
 * because a project that declares its own `tsconfig` replaces the whole object.
 */
const LANGUAGE_LEVEL = { lib: ["es2023"], target: "es2023" } as const;

const root = new typescript.TypeScriptProject({
  ...common,
  name: "platform",
  description:
    "Paved road onto GCP: secure-by-default Pulumi components and the CLI that scaffolds services onto them.",
  projenrcTs: true,
  // Node's own type stripping needs no compiler API, unlike ts-node.
  projenrcTsOptions: { runner: typescript.TypeScriptRunner.nodejs() },
  // yaml is test-only: test/ci.test.ts parses the emitted workflows rather than
  // string-matching them, so a malformed one fails here.
  devDeps: [
    VITEST,
    VITEST_COVERAGE,
    "oxlint@1.80.0",
    "oxlint-tsgolint@7.0.2001",
    "yaml@^2.9.0",
  ],

  // The platform's own CI. Only the root gets a workflow — `common` leaves
  // github off, and subprojects would otherwise each emit their own.
  //
  // Same suppression the scaffold uses: left alone, projen also adds release,
  // deps-upgrade, PR-lint, mergify and a PR template.
  github: true,
  githubOptions: { mergify: false, pullRequestLint: false },
  pullRequestTemplate: false,
  depsUpgrade: false,
  workflowNodeVersion: NODE_VERSION,
  workflowPackageCache: true,
  buildWorkflowOptions: {
    // projen defaults to pull_request + workflow_dispatch. With release off,
    // nothing would then verify main after a merge.
    workflowTriggers: {
      pullRequest: {},
      push: { branches: ["main"] },
      workflowDispatch: {},
    },
    // Without this the build job dies with MODULE_NOT_FOUND on projen's own
    // CLI. `projen build` synthesises, and post-synthesis installs
    // dependencies — per subproject, because projen has no npm-workspaces
    // awareness (see C1's findings). In CI that install is `npm ci`, which
    // deletes node_modules and takes the running projen with it. The workflow
    // already installs in its own step, so post-synthesis has nothing to add.
    env: { PROJEN_DISABLE_POST: "true" },
    // Frozen-lockfile installs (`npm ci`), not `npm install`.
    //
    // Node 22.18 bundles npm 10, which strips the `libc` fields npm 11 writes
    // into a lockfile. A mutable install therefore rewrote package-lock.json on
    // every run and the mutation check failed the build. `npm ci` never writes
    // the lockfile, so the npm version cannot cause drift — and a dependency
    // committed without a matching lockfile now fails loudly instead of being
    // silently rewritten. Self-mutation stays on for genuinely stale output.
    mutableInstall: false,
  },
  // The root holds only repo-level invariant tests; there is no src/ to compile.
  // rootDir must widen to "." to match: projen defaults it to srcdir, which
  // would make `tsc --noEmit` at the root fail TS6059 on its own test files.
  tsconfig: {
    include: ["test/**/*.ts"],
    compilerOptions: { rootDir: ".", ...LANGUAGE_LEVEL },
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
  // yaml is test-only: the CI-workflow tests parse the emitted workflow rather
  // than string-matching it, so a malformed file fails rather than slipping
  // through. Caret range, per SPEC.md: exact pins are for @pulumi/* only.
  devDeps: [VITEST, VITEST_COVERAGE, "yaml@^2.9.0"],
  tsconfig: { compilerOptions: { ...LANGUAGE_LEVEL } },
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
 * Security scanning, in its own workflow rather than bolted onto `build`.
 *
 * Three jobs because the three tools answer different questions and fail for
 * different reasons: a vulnerable dependency, a committed credential, and a
 * flaw in code we wrote ourselves. Folding them into one job would collapse
 * three distinct signals into a single red X.
 */
if (!root.github) {
  throw new Error("root.github is required: the security workflow attaches to it");
}
const security = root.github.addWorkflow("security");
security.on({
  pullRequest: {},
  push: { branches: ["main"] },
  workflowDispatch: {},
});

const checkout = {
  name: "Checkout",
  uses: "actions/checkout@v4",
};

security.addJob("audit", {
  runsOn: ["ubuntu-latest"],
  permissions: { contents: JobPermission.READ },
  steps: [
    checkout,
    {
      name: "Setup Node.js",
      uses: "actions/setup-node@v4",
      with: { "node-version": NODE_VERSION, cache: "npm" },
    },
    { name: "Install dependencies", run: "npm ci" },
    // .npmrc sets legacy-peer-deps, which disables npm's own compatibility
    // checking repo-wide. Auditing is part of what compensates for that.
    // --audit-level=high so a low-severity advisory in a dev dependency does
    // not block every pull request.
    { name: "Audit dependencies", run: "npm audit --audit-level=high" },
  ],
});

security.addJob("secrets", {
  runsOn: ["ubuntu-latest"],
  permissions: { contents: JobPermission.READ },
  steps: [
    // fetch-depth 0: a credential committed earlier and removed later is still
    // in the history, and still leaked.
    { ...checkout, with: { "fetch-depth": 0 } },
    {
      name: "Scan for committed credentials",
      uses: "gitleaks/gitleaks-action@v2",
      env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" },
    },
  ],
});

security.addJob("codeql", {
  runsOn: ["ubuntu-latest"],
  permissions: {
    contents: JobPermission.READ,
    // CodeQL uploads its findings to the repository's security tab.
    securityEvents: JobPermission.WRITE,
  },
  steps: [
    checkout,
    {
      name: "Initialize CodeQL",
      uses: "github/codeql-action/init@v3",
      // No build step: CodeQL extracts TypeScript directly.
      with: { languages: "javascript-typescript" },
    },
    {
      name: "Analyze",
      uses: "github/codeql-action/analyze@v3",
    },
  ],
});

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
  peerDeps: [PULUMI, PULUMI_GCP, PULUMI_POLICY],
  devDeps: [VITEST, VITEST_COVERAGE],
  tsconfig: { compilerOptions: { ...LANGUAGE_LEVEL } },
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
/**
 * The CrossGuard policy pack directory.
 *
 * **Precompiled JavaScript, and `typescript: false` is load-bearing.** Pulumi
 * runs .ts programs through ts-node, which cannot load under TypeScript 7
 * (`ts.sys` is undefined). It only reaches for ts-node when
 * PULUMI_NODEJS_TYPESCRIPT is "true" — set from `runtime.options.typescript`
 * (`@pulumi/pulumi/cmd/run/run.js:234`). With it false, Pulumi runs the compiled
 * JS and ts-node is never loaded. Flip this to true and the pack stops running
 * entirely.
 */
new TextFile(gcpComponents, "policy/PulumiPolicy.yaml", {
  lines: [
    "# ~~ Generated by projen. To modify, edit .projenrc.ts and run \"npx projen\".",
    "name: runway-gcp",
    "description: Secure-by-default guardrails for GCP Cloud Run, enforced on raw resources.",
    "runtime:",
    "  name: nodejs",
    "  options:",
    "    # ts-node cannot load under TypeScript 7. Keep this false and ship compiled JS.",
    "    typescript: false",
    "",
  ],
});

new JsonFile(gcpComponents, "policy/package.json", {
  marker: false,
  obj: {
    name: "runway-gcp-policy",
    version: "0.0.1",
    main: "index.js",
    private: true,
    // Declared so the install set has one authoritative home. The pack is not
    // installed in place -- see the `policy:install` task -- but a consumer
    // reading this file should be able to see what it needs.
    dependencies: Object.fromEntries(
      [PULUMI, PULUMI_POLICY, PULUMI_GCP, POLICY_TYPESCRIPT].map((spec) => {
        const at = spec.lastIndexOf("@");
        return [spec.slice(0, at), spec.slice(at + 1)];
      }),
    ),
  },
});

/**
 * Installs the policy pack into its own tree so it can actually run.
 *
 * The pack cannot execute from inside a repo that pins TypeScript 7 -- the
 * runner would resolve that compiler and die. This gives it a tree whose
 * nearest `typescript` is one Pulumi can use.
 */
gcpComponents.addTask("policy:install", {
  description: `Install the policy pack into ${POLICY_DIR}/ so it can be run`,
  // --install-links is load-bearing, not tidiness. Without it npm *symlinks* a
  // local package, Node resolves through the real path, and the pack lands back
  // inside the monorepo where TypeScript 7 resolves -- silently undoing the
  // isolation this task exists to create. Measured: the symlinked form fails
  // with the same ts.sys.readFile error as no isolation at all.
  // The `rm -rf` is load-bearing too. npm skips re-copying a package it
  // already has at the same version, and this package's version never changes
  // -- so re-running over an existing install silently keeps the OLD pack.
  // Measured: a rebuilt pack with two new rules did not propagate, and the
  // preview went green with those rules simply absent. That is the exact
  // silent failure this whole task exists to prevent.
  exec:
    `rm -rf ${POLICY_DIR} && npm install --prefix ${POLICY_DIR} ` +
    `--no-audit --no-fund --legacy-peer-deps ` +
    `--install-links . ${PULUMI} ${PULUMI_POLICY} ${PULUMI_GCP} ${POLICY_TYPESCRIPT}`,
});

gcpComponents.gitignore.exclude(`${POLICY_DIR}/`);

new TextFile(gcpComponents, "policy/index.js", {
  lines: [
    "// ~~ Generated by projen. To modify, edit .projenrc.ts and run \"npx projen\".",
    "// Entry point Pulumi loads. Requires the compiled pack: no ts-node involved,",
    "// which is what lets this run at all on TypeScript 7.",
    "require(\"../lib/policy/pack\").createPolicyPack();",
    "",
  ],
});

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
        // to be discarded. This holds wherever projen components are declared:
        // the projenrc, and the project types runway-cli emits.
        files: [".projenrc.ts", "packages/*/src/templates/**/*.ts"],
        rules: { "no-new": "off" },
      },
    ],
    ignorePatterns: ["lib/", "node_modules/", "packages/*/lib/"],
  },
});

// .claude/worktrees/ is where EnterWorktree puts isolated checkouts. Untracked,
// it would show up in `git status` and break the clean-tree checks each task runs.
// .claude/settings.json accumulates local tool-permission entries as they are
// granted. It is per-machine state, not shared configuration, and this repo is
// public — it had been carrying a stale email address in recorded commands.
root.gitignore.exclude(
  "dist/",
  ".tmp-scaffold/",
  ".claude/worktrees/",
  ".claude/settings.json",
);

root.synth();
