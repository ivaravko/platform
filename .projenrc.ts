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

/**
 * Where @runway/* is published, and at what version.
 *
 * A published version is permanent -- Artifact Registry will not accept
 * different bytes under the same number -- and every generated repo pins
 * whatever ships first. 0.1.0 rather than 0.0.0: real, pre-1.0, expect change.
 */
const PACKAGE_VERSION = "0.1.0";
const REGISTRY =
  "https://europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/";

/**
 * Publishable packages carry a version, a registry, and an allowlist of what
 * ships. The root carries none of them.
 *
 * `files` is an allowlist because projen's .npmignore is a denylist, and npm
 * ignores .gitignore entirely once .npmignore exists -- so anything a task
 * leaves on disk that projen never heard of gets published. The policy-pack
 * test installs a dependency tree into .runway-policy/, which put 20,511 files
 * and 161MB into the gcp-components tarball. A denylist has to predict that; an
 * allowlist does not.
 */
const publishable = (
  project: typescript.TypeScriptProject,
  extraPaths: string[] = [],
): void => {
  project.package.addField("version", PACKAGE_VERSION);
  project.package.addField("publishConfig", { registry: REGISTRY });
  // package.json, README and LICENSE are always included by npm.
  project.package.addField("files", ["lib", ...extraPaths]);
};

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
    // Integration-tier only: the fixture stacks import the components and are
    // compiled against the real provider. devDeps, not deps — the root is
    // private and publishes nothing, so none of this reaches a consumer.
    // Exact pins for @pulumi/*, per SPEC.md; they must match gcp-components'
    // peer ranges or the fixtures compile against a different provider than
    // the components were written for.
    PULUMI,
    PULUMI_GCP,
    "@runway/gcp-components@*",
    // Tier B reads deployed state back through the Cloud Run API rather than
    // through Pulumi state. Google's own auth library rather than shelling out
    // to gcloud: it reads application-default credentials directly, which is
    // also the form `google-github-actions/auth` produces over WIF, so CI needs
    // no gcloud install. Caret range — it is dev tooling, not a @pulumi/* pin.
    "google-auth-library@^10",
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
  // test-integration/ is typechecked but never run here. Typechecking it is
  // offline and credential-free, so the gate keeps catching type errors in the
  // integration tier; only *running* it needs GCP.
  tsconfig: {
    include: ["test/**/*.ts", "test-integration/**/*.ts"],
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
  // peerDeps, not deps, for the same reason @pulumi/* is a peer of
  // gcp-components: RunwayServiceProject *extends* projen's TypeScriptProject,
  // and the consumer's .projenrc.ts imports projen itself. Two copies would put
  // the subclass on a different class object than the one the consumer resolves,
  // and projen's component registry would see two unrelated Project types.
  //
  // Nothing declared it at all until E9 -- inside the workspace it resolved from
  // the hoisted root, so every build and test passed while the published tarball
  // would have failed on `runway new` with MODULE_NOT_FOUND.
  peerDeps: ["projen@^0.103.2"],
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
publishable(cli);
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
 * The integration tier: `pulumi preview` and `pulumi up` against the sandbox.
 *
 * **Deliberately not spawned by `build` or `test`.** SPEC.md requires the pull-
 * request gate to be credential-free and offline, and these tasks are neither.
 *
 * The isolation is structural rather than a filter. `root.testTask` runs
 * `vitest run --dir test`, and this tree is `test-integration/` — a sibling, so
 * the gate cannot collect it even by accident. An `--exclude` pattern would put
 * the same guarantee behind a flag that a later edit could drop silently, and
 * the failure mode is a pull request trying to deploy to GCP.
 *
 * Split into two tasks by directory rather than by vitest projects: a tier that
 * only previews and a tier that deploys are different enough in risk to be
 * different commands, and one directory each needs no config file to say so.
 */
/**
 * Fixture stacks are the one tree in this repo that must emit JavaScript.
 *
 * Pulumi runs `.ts` stack programs through ts-node, which throws under
 * TypeScript 7. `Pulumi.yaml` therefore declares `typescript: false` and points
 * `main` at the output of this task. Both halves are load-bearing: without the
 * compile there is nothing to run, and without `typescript: false` Pulumi loads
 * ts-node anyway and dies before reading a line of the program.
 */
const compileFixtures = root.addTask("compile:fixtures", {
  description: "Precompile integration fixture stacks; Pulumi cannot run TS 7 sources",
  exec: "tsc -p test-integration/fixtures/tsconfig.json",
});

const previewTier = root.addTask("test:integration:preview", {
  description: "Integration tier A: pulumi preview against the sandbox; creates nothing",
  exec: "vitest run --dir test-integration/preview",
  receiveArgs: true,
});
const deployTier = root.addTask("test:integration:deploy", {
  description: "Integration tier B: deploys to the sandbox, asserts, destroys",
  // Sequential by file. Parallel files would deploy into one project at once,
  // which makes cost unpredictable and, worse, makes "the sandbox is empty"
  // unanswerable — a leak and a concurrent test look identical.
  exec: "vitest run --dir test-integration/deploy --no-file-parallelism",
  receiveArgs: true,
});

/**
 * The emptiness check, in its own task and its own directory.
 *
 * It cannot live alongside the deploy tests. vitest gives no ordering guarantee
 * across files, so an emptiness assertion sharing a run with tests that deploy
 * would be asserting against a moving target — green or red depending on
 * scheduling, which is the worst possible behaviour for a leak detector.
 */
const verifyEmpty = root.addTask("test:integration:verify", {
  description: "Assert the sandbox holds nothing after the tiers have run",
  exec: "vitest run --dir test-integration/verify",
  receiveArgs: true,
});

const integration = root.addTask("test:integration", {
  description: "Both integration tiers, as CI runs them. Needs GCP credentials.",
});
integration.spawn(previewTier);
integration.spawn(deployTier);
// Last, and always: a run that leaked is a run that must go red, even when
// every assertion in it passed.
integration.spawn(verifyEmpty);

// Both tiers run compiled fixtures, so neither can start without this.
previewTier.prependSpawn(compileFixtures);
deployTier.prependSpawn(compileFixtures);

// Emitted JavaScript, regenerated by compile:fixtures on every run.
root.gitignore.addPatterns("test-integration/fixtures/lib/");
// Per-stack settings are an artifact, not source. Pulumi writes an
// `encryptionsalt` into them keyed to the passphrase that created the stack, so
// a committed one pins the repo to a fixed passphrase and an uncommitted one
// leaves the tree permanently dirty. The tier sets config programmatically and
// removes the stack afterwards; these files exist only mid-run.
root.gitignore.addPatterns("test-integration/fixtures/*/Pulumi.*.yaml");

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
 * The integration tier's workflow (T12): nightly and on demand, never on a
 * pull request — the PR gate stays credential-free and offline, and the
 * isolation is the trigger set itself rather than a filter inside a shared
 * workflow.
 *
 * Inert until federation for this repository exists, the same forward
 * contract as the scaffold's package job: skipped, not red, while the
 * repository variables are unset. The sandbox project id reaches the run
 * through a variable and is then held to `assertSandbox()`, which rejects
 * anything but the one designated project — so the variable cannot point the
 * tier somewhere else, and no project id is baked into `.github/`.
 */
const integrationWorkflow = root.github.addWorkflow("integration");
integrationWorkflow.on({
  // 03:17 UTC: off the top of the hour, where GitHub's cron load spikes and
  // scheduled runs are most often delayed or dropped.
  schedule: [{ cron: "17 3 * * *" }],
  workflowDispatch: {},
});

integrationWorkflow.addJob("integration", {
  runsOn: ["ubuntu-latest"],
  permissions: {
    contents: JobPermission.READ,
    // What lets google-github-actions/auth mint a federated credential — the
    // only kind this repo's Never list permits. No stored secret exists.
    idToken: JobPermission.WRITE,
  },
  if: "${{ vars.RUNWAY_PLATFORM_WIF_PROVIDER != '' }}",
  env: { GOOGLE_CLOUD_PROJECT: "${{ vars.RUNWAY_SANDBOX_PROJECT }}" },
  steps: [
    checkout,
    {
      name: "Authenticate to Google Cloud",
      uses: "google-github-actions/auth@v2",
      with: {
        workload_identity_provider: "${{ vars.RUNWAY_PLATFORM_WIF_PROVIDER }}",
        service_account: "${{ vars.RUNWAY_PLATFORM_CI_SERVICE_ACCOUNT }}",
      },
    },
    {
      name: "Setup Node.js",
      uses: "actions/setup-node@v4",
      with: { "node-version": NODE_VERSION, cache: "npm" },
    },
    {
      name: "Install Pulumi",
      run: 'curl -fsSL https://get.pulumi.com | sh && echo "$HOME/.pulumi/bin" >> "$GITHUB_PATH"',
    },
    { name: "Install dependencies", run: "npm ci" },
    { name: "Integration tiers", run: "npm run test:integration" },
    {
      // `test:integration` ends with this same task, but a mid-tier crash
      // never reaches it — and an unverified sandbox after a failed run is
      // exactly when a leak is likeliest.
      name: "Verify the sandbox is empty",
      if: "always()",
      run: "npm run test:integration:verify",
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

// policy/ ships: the pack must load from a consumer tree, not only from here.
publishable(gcpComponents, ["policy"]);
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

/**
 * The identity boundary. Fourth in the capability map's build order — the
 * module whose whole purpose is that a developer holding every credential they
 * legitimately possess still cannot deploy to production.
 *
 * @pulumi/* as peers, not deps, for the same reason as gcp-components: two
 * copies of @pulumi/pulumi in one program break resource registration, and a
 * published library that bundles its own copy makes that the consumer's
 * problem. projen pins them as devDeps too, so tests still resolve them.
 * (They arrived with E3's `ServiceEnvironment` — E1 and E2 were pure logic,
 * which is also what keeps the audit structurally unable to write IAM: the
 * audit path itself still imports nothing with a network client.)
 */
const environmentProvisioning = new typescript.TypeScriptProject({
  ...common,
  parent: root,
  outdir: "packages/environment-provisioning",
  name: "@runway/environment-provisioning",
  description:
    "The identity boundary for GCP services: production is deployable precisely by the identity localhost does not have.",
  // PULUMI_POLICY for the EP-03 rule the bootstrap stack enforces — a peer
  // for the same no-second-copy reason as the others.
  peerDeps: [PULUMI, PULUMI_GCP, PULUMI_POLICY],
  devDeps: [VITEST, VITEST_COVERAGE],
  tsconfig: { compilerOptions: { ...LANGUAGE_LEVEL } },
});

publishable(environmentProvisioning);
environmentProvisioning.testTask.exec("vitest run", { receiveArgs: true });
addTypecheckTask(environmentProvisioning, "test/tsconfig.json");
addLintTasks(environmentProvisioning);

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
        //
        // Pulumi resources register the same way, so integration fixtures need
        // the same allowance: a stack declaring a resource nothing else
        // references is not a mistake, it is the whole program.
        files: [
          ".projenrc.ts",
          "packages/*/src/templates/**/*.ts",
          "test-integration/fixtures/**/*.ts",
        ],
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
