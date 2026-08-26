import { resolve } from "node:path";
import {
  JsonFile,
  SampleFile,
  TextFile,
  github,
  javascript,
  typescript,
} from "projen";

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
/**
 * The generated service is a React SPA served by a Node process.
 *
 * vite rather than a second bundler because vitest already shares its config,
 * and happy-dom because a component test needs something to render into.
 * Verified against TypeScript 7: vite transpiles with esbuild and never loads
 * the compiler API, so none of the ts-node breakage applies.
 */
const CLIENT = [
  "react@^19",
  "react-dom@^19",
] as const;
const CLIENT_DEV = [
  "@types/react@^19",
  "@types/react-dom@^19",
  "vite@^7",
  "@vitejs/plugin-react@^5",
  "happy-dom@^20",
  "@testing-library/react@^16",
  "@testing-library/dom@^10",
] as const;
const OXLINT = "oxlint@1.80.0";
const OXLINT_TSGOLINT = "oxlint-tsgolint@7.0.2001";

/**
 * Where `@runway/*` is published, and which version a generated repo pins.
 *
 * Before E9 these were `file:` links to absolute paths inside whichever home
 * directory ran `runway new`. The repo built on that one machine and nowhere
 * else -- not on a colleague's checkout, not in CI, not inside a container --
 * which is what blocked the Dockerfile.
 *
 * A caret range rather than an exact pin, per SPEC.md's version policy: exact
 * pins are for `@pulumi/*`, where a mismatched provider is a real hazard. The
 * generated repo commits a lockfile, so the caret widens what an explicit
 * upgrade may resolve to without changing what an ordinary install gets.
 */
const RUNWAY_VERSION = "^0.1.0";
const RUNWAY_REGISTRY =
  "https://europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/";

/**
 * Escape hatch for this repository's own build-out tests.
 *
 * Those tests run a real `npm install` on a scaffold as a blocking gate, and
 * the published registry needs Google credentials that the platform's CI does
 * not have -- so gating on it would make a unit tier depend on GCP auth. With
 * this set, the scaffold links the workspace copies instead.
 *
 * It is deliberately not a constructor option: `runway new` reaches the project
 * type through the CLI binary, so a test driving the real command line has no
 * other way to reach it. The published default is what every user gets, and the
 * integration tier -- which already needs credentials -- proves that path.
 */
const localPackage = (name: string): string | undefined =>
  process.env.RUNWAY_LINK_LOCAL_PACKAGES
    ? `file:${resolve(cliPackageRoot(), "..", name)}`
    : undefined;

export interface RunwayServiceProjectOptions {
  /** Service name. Becomes the package name and the repository directory. */
  readonly name: string;

  /** Directory to generate into. @default - a directory named after the service */
  readonly outdir?: string;

  /**
   * GCP region for both environments, e.g. "europe-west1".
   *
   * Required, because it is the one value the scaffold cannot derive. The
   * project ids come from the service name; the region does not, and a stack
   * config missing it produces a repository that cannot preview.
   */
  readonly region: string;

  /**
   * How the generated repo resolves `@runway/cli` to regenerate itself.
   *
   * Defaults to the published version. Override to test a scaffold against an
   * unreleased build without publishing one.
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
    const runwayCli =
      options.runwayCliVersion ?? localPackage("runway-cli") ?? RUNWAY_VERSION;

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
      devDeps: [
        VITEST,
        OXLINT,
        OXLINT_TSGOLINT,
        ...CLIENT_DEV,
        `@runway/cli@${runwayCli}`,
      ],

      // JSX and the DOM lib are what let tsc typecheck the client at all.
      tsconfig: {
        compilerOptions: {
          jsx: javascript.TypeScriptJsxMode.REACT_JSX,
          lib: ["es2023", "dom"],
        },
      },

      // The components the infra program composes.
      deps: [
        PULUMI,
        PULUMI_GCP,
        `@runway/gcp-components@${
          localPackage("gcp-components") ?? RUNWAY_VERSION
        }`,
        ...CLIENT,
      ],

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

    // The local-link escape hatch must also cover @runway/cli's own runtime
    // dependency on @runway/environment-provisioning: a file:-linked cli still
    // resolves its dep tree through npm, which would otherwise fetch e-p from
    // the authenticated registry and break the offline build-out tier. An
    // override pins the transitive resolution to the workspace copy; in the
    // published default no override is emitted and the registry serves it.
    const environmentProvisioning = localPackage("environment-provisioning");
    if (environmentProvisioning !== undefined) {
      this.package.addField("overrides", {
        "@runway/environment-provisioning": environmentProvisioning,
      });
    }

    this.addStackConfig(options.region);
    this.addContainerImage(options.region);
    this.addReleaseWorkflow(options.region);
    this.addClientBuild();
    this.testTask.exec("vitest run", { receiveArgs: true });
    this.addLintTasks();
    this.addOxlintConfig();
    this.addNpmrc();
    this.addSampleCode(runwayCli);
  }

  /**
   * One stack config per environment, differing only in the project they target.
   *
   * Project ids are derived from the service name — `<name>-staging` and
   * `<name>-production` — which is the same rule `environment-provisioning`
   * adopts under. Neither module tells the other an identifier; both compute it.
   *
   * These are the values `infra/index.ts` requires. Writing them here is what
   * makes a generated repo previewable without a configuration step nobody
   * documented.
   */
  private addStackConfig(region: string): void {
    for (const environment of ["staging", "production"] as const) {
      new SampleFile(this, `infra/Pulumi.${environment}.yaml`, {
        contents: [
          "config:",
          `  gcp:project: ${this.name}-${environment}`,
          `  gcp:region: ${region}`,
          // Staging starts from a tag. Production deliberately carries no
          // image: there is nothing to promote yet, and a tag here would leave
          // production tracking something mutable. CI writes imageDigest at
          // promotion time.
          ...(environment === "staging" ? ["  imageTag: v1"] : []),
          "",
        ].join("\n"),
      });
    }
  }

  /**
   * The artifact release-path promotes: a Dockerfile, and a `package` job in
   * the build workflow that builds it on every run and pushes it on `main`.
   *
   * This closes the blocker SPEC-release-path.md records: the registry
   * component created a repository nothing wrote to. It also ships **before**
   * `environment-provisioning` exists, so the job is inert — skipped, not
   * failing — until `runway bootstrap` creates the federation it authenticates
   * with and the team sets the two repository variables it names. That is the
   * forward contract: RUNWAY_WIF_PROVIDER and RUNWAY_CI_SERVICE_ACCOUNT.
   */
  private addContainerImage(region: string): void {
    new TextFile(this, "Dockerfile", {
      lines: [
        '# ~~ Generated by projen. To modify, edit .projenrc.ts and run "npx projen".',
        "#",
        "# Two stages, because the builder and the shipped image need nothing in",
        "# common: the builder wants the whole toolchain and a registry credential;",
        "# the image wants Node and two directories. The server imports only Node",
        "# builtins and vite bundles the client's dependencies into its output, so",
        "# no node_modules ships and nothing installs at runtime.",
        "",
        `FROM node:${NODE_VERSION}-slim AS build`,
        "WORKDIR /app",
        "",
        "# The committed .npmrc supplies the @runway scope mapping; the credential",
        "# arrives as a BuildKit secret, mounted for this one step and absent from",
        "# every layer. Locally:",
        "#",
        "#   docker build --secret id=npmrc,src=$HOME/.npmrc .",
        "COPY package.json package-lock.json .npmrc ./",
        "RUN --mount=type=secret,id=npmrc,target=/root/.npmrc npm ci",
        "",
        "# The same entry point CI and a laptop use: tsc for the server, vite for",
        "# the client. (It also compiles infra/, which the image never runs — the",
        "# price of one build command rather than three.)",
        "COPY . .",
        "RUN npm run compile",
        "",
        `FROM node:${NODE_VERSION}-slim`,
        "ENV NODE_ENV=production",
        "WORKDIR /app",
        "COPY --from=build /app/lib ./lib",
        "COPY --from=build /app/dist ./dist",
        "USER node",
        "# Cloud Run supplies PORT; 8080 is its default, and the server's.",
        "EXPOSE 8080",
        'CMD ["node", "lib/server/index.js"]',
        "",
      ],
    });

    new TextFile(this, ".dockerignore", {
      lines: [
        '# ~~ Generated by projen. To modify, edit .projenrc.ts and run "npx projen".',
        "#",
        "# The builder compiles from source; anything the laptop already built must",
        "# not leak into the context, or the image ships whatever was lying around",
        "# instead of what this commit says.",
        "node_modules",
        "lib",
        "dist",
        "infra/lib",
        ".git",
        "",
      ],
    });

    // The same derivation rule as the stack configs: project ids come from the
    // service name. The path is SecureArtifactRepository's prefix in the
    // staging stack, plus the service name — matching infra/index.ts.
    const image = `${region}-docker.pkg.dev/${this.name}-staging/${this.name}/${this.name}`;
    const npmHost = RUNWAY_REGISTRY.replace(/^https:/, "");
    const token = "${{ steps.auth.outputs.access_token }}";

    this.buildWorkflow?.addPostBuildJob("package", {
      runsOn: ["ubuntu-latest"],
      permissions: {
        contents: github.workflows.JobPermission.READ,
        // What lets google-github-actions/auth mint a federated credential —
        // the only kind this path is allowed to hold. No stored secret exists.
        idToken: github.workflows.JobPermission.WRITE,
      },
      // Inert until bootstrapped, and skipped on fork PRs, which cannot mint
      // an identity token.
      if: [
        "${{ vars.RUNWAY_WIF_PROVIDER != '' &&",
        "(github.event_name != 'pull_request' ||",
        "github.event.pull_request.head.repo.full_name == github.repository) }}",
      ].join(" "),
      env: { IMAGE: image },
      steps: [
        { uses: "actions/checkout@v4" },
        {
          id: "auth",
          uses: "google-github-actions/auth@v2",
          with: {
            workload_identity_provider: "${{ vars.RUNWAY_WIF_PROVIDER }}",
            service_account: "${{ vars.RUNWAY_CI_SERVICE_ACCOUNT }}",
            token_format: "access_token",
          },
        },
        {
          name: "Build the image",
          // The token reaches npm ci as a BuildKit secret, exactly as a
          // laptop build does it — one Dockerfile, no CI-only code path.
          run: [
            `printf '%s:_authToken=%s\\n' '${npmHost}' '${token}' > "$RUNNER_TEMP/npmrc"`,
            'docker build --secret id=npmrc,src="$RUNNER_TEMP/npmrc" -t "$IMAGE:sha-$GITHUB_SHA" .',
          ].join("\n"),
        },
        {
          name: "Push the image",
          // Pull requests prove the image still builds; only main publishes.
          // The sha tag is unique per commit, which is what an immutable-tag
          // registry requires — nothing ever re-tags.
          if: "github.event_name == 'push' && github.ref == 'refs/heads/main'",
          run: [
            `printf '%s' '${token}' | docker login -u oauth2accesstoken --password-stdin ${region}-docker.pkg.dev`,
            'docker push "$IMAGE:sha-$GITHUB_SHA"',
          ].join("\n"),
        },
      ],
    });
  }

  /**
   * The only route to production: SPEC-release-path.md, generated.
   *
   * A second workflow rather than a job in `build.yml`, because its trigger,
   * its permissions and its failure meaning are all different — a red build
   * means the code is wrong; a red release means production did not change.
   *
   * Two triggers, one path. A pushed `v*` tag is a release; a dispatch on an
   * existing tag's ref is a rollback (RP-06) — the same run, re-asked-for,
   * with the asking actor in the log. Dispatching on a branch dies at the
   * first step, and would die at Google's door regardless.
   *
   * Unlike the `package` job this one does not skip when the bootstrap
   * variables are missing: a pushed tag is an explicit release request, and a
   * release that silently does nothing is the swallowed error RP-03 warns
   * about. It goes red, naming what to set.
   */
  private addReleaseWorkflow(region: string): void {
    if (this.github === undefined) {
      return;
    }

    const staging = `${region}-docker.pkg.dev/${this.name}-staging/${this.name}/${this.name}`;
    const production = `${region}-docker.pkg.dev/${this.name}-production/${this.name}/${this.name}`;
    const npmHost = RUNWAY_REGISTRY.replace(/^https:/, "");

    const workflow = new github.GithubWorkflow(this.github, "release");
    workflow.on({ push: { tags: ["v*"] }, workflowDispatch: {} });

    workflow.addJob("release", {
      runsOn: ["ubuntu-latest"],
      permissions: {
        contents: github.workflows.JobPermission.READ,
        idToken: github.workflows.JobPermission.WRITE,
      },
      env: {
        STAGING_IMAGE: staging,
        PRODUCTION_IMAGE: production,
      },
      steps: [
        {
          name: "Refuse a non-tag ref",
          if: "github.ref_type != 'tag'",
          run: [
            'echo "release runs only on a tag ref. To roll back, dispatch on the tag itself:" >&2',
            'echo "  gh workflow run release.yml --ref v1.2.3" >&2',
            "exit 1",
          ].join("\n"),
        },
        {
          name: "Refuse to run unbootstrapped",
          if: "vars.RUNWAY_WIF_PROVIDER == '' || vars.RUNWAY_CI_SERVICE_ACCOUNT == '' || vars.RUNWAY_PRODUCTION_STATE_BACKEND == ''",
          run: [
            'echo "Not bootstrapped: set the repository variables RUNWAY_WIF_PROVIDER," >&2',
            'echo "RUNWAY_CI_SERVICE_ACCOUNT and RUNWAY_PRODUCTION_STATE_BACKEND." >&2',
            "exit 1",
          ].join("\n"),
        },
        { uses: "actions/checkout@v4" },
        {
          id: "auth",
          uses: "google-github-actions/auth@v2",
          with: {
            workload_identity_provider: "${{ vars.RUNWAY_WIF_PROVIDER }}",
            service_account: "${{ vars.RUNWAY_CI_SERVICE_ACCOUNT }}",
            token_format: "access_token",
          },
        },
        {
          id: "resolve",
          name: "Resolve the tagged commit to a digest",
          // RP-02 and RP-03. The digest is the image build.yml pushed for
          // this exact commit — resolving the git tag's own name would need
          // something to have rebuilt, and promotion is an artifact moving.
          // `describe` fails non-zero on a missing image, which fails the
          // release before any deploy step; the emptiness check is belt and
          // braces, because RP-03 is the control the spec says will be
          // skipped.
          run: [
            'digest="$(gcloud artifacts docker images describe \\',
            "  \"$STAGING_IMAGE:sha-$GITHUB_SHA\" --format='value(image_summary.digest)')\"",
            'test -n "$digest"',
            'echo "$GITHUB_REF_NAME resolves to $digest"',
            'echo "digest=$digest" >> "$GITHUB_OUTPUT"',
          ].join("\n"),
        },
        {
          uses: "actions/setup-node@v4",
          with: { "node-version": NODE_VERSION, cache: "npm" },
        },
        {
          name: "Build the infra program",
          // Pulumi runs `main: lib/index.js`; only infra needs compiling.
          run: [
            `printf '%s:_authToken=%s\\n' '${npmHost}' '\${{ steps.auth.outputs.access_token }}' > "$RUNNER_TEMP/npmrc"`,
            'npm ci --userconfig "$RUNNER_TEMP/npmrc"',
            "npm run compile:infra",
          ].join("\n"),
        },
        {
          name: "Ensure the production registry exists",
          // The two-phase first apply, encoded here because production's only
          // deployer is this workflow: a brand-new environment cannot receive
          // the digest copy before the registry exists, and the registry is
          // part of the very stack being deployed. Phase one targets it (a
          // no-op from the second release on); the copy runs; the full apply
          // follows. `stack init` on the first release ever — nothing else is
          // permitted to initialise production's stack.
          env: {
            DIGEST: "${{ steps.resolve.outputs.digest }}",
            // Config here holds no secret; stacks initialised with the
            // default passphrase provider and no passphrase deploy as-is.
            PULUMI_CONFIG_PASSPHRASE: "",
          },
          run: [
            "curl -fsSL https://get.pulumi.com | sh",
            'echo "$HOME/.pulumi/bin" >> "$GITHUB_PATH"',
            'export PATH="$HOME/.pulumi/bin:$PATH"',
            "pulumi login \"${{ vars.RUNWAY_PRODUCTION_STATE_BACKEND }}\"",
            "cd infra",
            "pulumi stack select production || pulumi stack init production",
            'pulumi config set imageDigest "$DIGEST"',
            // No --target-dependents, learned from the first real two-phase
            // apply: the Cloud Run service *depends on* the registry, so
            // "dependents" drags the whole stack into phase one and errors on
            // everything else that was not targeted. A target's own
            // dependencies come along implicitly, which is all phase one needs.
            "pulumi up --target '**SecureArtifactRepository**' --yes",
          ].join("\n"),
        },
        {
          name: "Promote the artifact into the production registry",
          // Each environment pulls from its own registry, so the digest must
          // exist in production's before Cloud Run is asked to pull it. A
          // push re-uploads the identical manifest, which preserves the
          // digest; the final describe proves it rather than assumes it. The
          // git tag becomes the registry-side name for the digest, so "what
          // shipped" is answerable from the production registry too.
          env: { DIGEST: "${{ steps.resolve.outputs.digest }}" },
          run: [
            `printf '%s' '\${{ steps.auth.outputs.access_token }}' | docker login -u oauth2accesstoken --password-stdin ${region}-docker.pkg.dev`,
            'docker pull "$STAGING_IMAGE@$DIGEST"',
            'docker tag "$STAGING_IMAGE@$DIGEST" "$PRODUCTION_IMAGE:$GITHUB_REF_NAME"',
            'docker push "$PRODUCTION_IMAGE:$GITHUB_REF_NAME"',
            'gcloud artifacts docker images describe "$PRODUCTION_IMAGE@$DIGEST" --format=\'value(image_summary.digest)\'',
          ].join("\n"),
        },
        {
          name: "Deploy the digest",
          env: { PULUMI_CONFIG_PASSPHRASE: "" },
          run: [
            "pulumi login \"${{ vars.RUNWAY_PRODUCTION_STATE_BACKEND }}\"",
            "cd infra",
            "pulumi stack select production",
            "pulumi up --yes",
          ].join("\n"),
        },
      ],
    });
  }

  /**
   * The client is bundled by vite, not by tsc.
   *
   * `compile` emits the server to lib/; this emits the client to dist/client,
   * which the server serves. Two build steps because they produce two different
   * kinds of artifact, not because the project is split.
   */
  private addClientBuild(): void {
    const client = this.addTask("compile:client", {
      description: "Bundle the React client into dist/client",
      exec: "vite build",
    });
    this.compileTask.spawn(client);
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
        "# @runway/* is published to Artifact Registry, not to npmjs.com, so the",
        "# scope mapping has to ship with the repo -- a version alone is",
        "# unresolvable without knowing where it lives.",
        "#",
        "# No credential here, deliberately. This file is committed; a token in it",
        "# would be a secret in git. Authenticate once, into your own ~/.npmrc:",
        "#",
        "#   npx google-artifactregistry-auth --credential-config=$HOME/.npmrc",
        "#",
        "# CI authenticates through Workload Identity Federation instead.",
        `@runway:registry=${RUNWAY_REGISTRY}`,
        `${RUNWAY_REGISTRY.replace(/^https:/, "")}:always-auth=true`,
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

    new SampleFile(this, "index.html", {
      contents: [
        "<!doctype html>",
        '<html lang="en">',
        "  <head>",
        '    <meta charset="utf-8" />',
        `    <title>${this.name}</title>`,
        "  </head>",
        "  <body>",
        '    <div id="root"></div>',
        '    <script type="module" src="/src/client/main.tsx"></script>',
        "  </body>",
        "</html>",
        "",
      ].join("\n"),
    });

    new SampleFile(this, "src/client/App.tsx", {
      contents: [
        "export const App = (): React.JSX.Element => (",
        `  <h1>${this.name} is running</h1>`,
        ");",
        "",
      ].join("\n"),
    });

    new SampleFile(this, "src/client/main.tsx", {
      contents: [
        `import { createRoot } from "react-dom/client";`,
        `import { App } from "./App";`,
        "",
        'const root = document.getElementById("root");',
        "if (root !== null) {",
        "  createRoot(root).render(<App />);",
        "}",
        "",
      ].join("\n"),
    });

    new SampleFile(this, "vite.config.ts", {
      contents: [
        `import react from "@vitejs/plugin-react";`,
        `import { defineConfig } from "vite";`,
        "",
        "export default defineConfig({",
        "  plugins: [react()],",
        "  // The server serves this directory; keep the two in step.",
        `  build: { outDir: "dist/client" },`,
        "});",
        "",
      ].join("\n"),
    });

    new SampleFile(this, "src/server/index.ts", {
      contents: [
        `import { readFile } from "node:fs/promises";`,
        `import { createServer } from "node:http";`,
        `import { basename, extname, join } from "node:path";`,
        "",
        "/** Cloud Run supplies PORT; 8080 is its default. */",
        "const port = Number(process.env.PORT ?? 8080);",
        `const clientDir = join(__dirname, "..", "..", "dist", "client");`,
        "",
        "const contentTypes: Record<string, string> = {",
        `  ".html": "text/html",`,
        `  ".js": "text/javascript",`,
        `  ".css": "text/css",`,
        "};",
        "",
        "export const server = createServer((req, res) => {",
        `  if (req.url === "/healthz") {`,
        `    res.writeHead(200, { "content-type": "application/json" });`,
        `    res.end(JSON.stringify({ status: "ok" }));`,
        "    return;",
        "  }",
        "",
        "  // Everything else is the single-page app. Only the basename is used,",
        "  // so a crafted URL cannot walk out of the client directory.",
        `  const requested = (req.url ?? "/").split("?")[0];`,
        `  const file = requested === "/" ? "index.html" : basename(requested);`,
        "",
        "  readFile(join(clientDir, file))",
        "    .then((body) => {",
        "      res.writeHead(200, {",
        `        "content-type": contentTypes[extname(file)] ?? "application/octet-stream",`,
        "      });",
        "      res.end(body);",
        "    })",
        "    .catch(() => {",
        "      res.writeHead(404).end();",
        "    });",
        "});",
        "",
        'if (process.env.NODE_ENV !== "test") {',
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

    new SampleFile(this, "test/server.test.ts", {
      contents: [
        `import { describe, expect, it } from "vitest";`,
        `import { server } from "../src/server";`,
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

    new SampleFile(this, "test/App.test.tsx", {
      contents: [
        "// @vitest-environment happy-dom",
        "//",
        "// Per-file, not global: a browser environment applies same-origin policy,",
        "// which blocks the server test's own fetch to 127.0.0.1.",
        `import { render, screen } from "@testing-library/react";`,
        `import { describe, expect, it } from "vitest";`,
        `import { App } from "../src/client/App";`,
        "",
        `describe("App", () => {`,
        `  it("renders a heading", () => {`,
        "    render(<App />);",
        "",
        `    expect(screen.getByRole("heading")).toBeTruthy();`,
        "  });",
        "});",
        "",
      ].join("\n"),
    });
  }
}

/**
 * Absolute path to this package, for the local-link escape hatch above.
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
    "## Container image",
    "",
    "The Dockerfile builds the deployable artifact: the compiled server and the",
    "bundled client on a plain Node image, with no node_modules at all. `npm ci`",
    "in the builder stage needs an Artifact Registry credential, mounted as a",
    "BuildKit secret so it never enters a layer:",
    "",
    "```bash",
    "docker build --platform linux/amd64 --secret id=npmrc,src=$HOME/.npmrc .",
    "```",
    "",
    "`--platform linux/amd64` matters on Apple Silicon: Cloud Run runs amd64",
    "only, and it rejects an arm64 manifest at deploy time — after the push,",
    "against an immutable tag. Learned the expensive way.",
    "",
    "In CI, the `package` job builds the image on every run and pushes it on",
    "pushes to `main`, tagged `sha-<commit>` — the registry's tags are immutable,",
    "so every push gets a fresh tag and nothing is ever re-tagged. The job",
    "authenticates by Workload Identity Federation and is **skipped** until two",
    "repository variables exist, which `runway bootstrap` will tell you to set:",
    "`RUNWAY_WIF_PROVIDER` and `RUNWAY_CI_SERVICE_ACCOUNT`.",
    "",
    "## Releasing",
    "",
    "```bash",
    "git tag v1.4.0 && git push origin v1.4.0   # deploy to production",
    "gh workflow run release.yml --ref v1.3.0   # roll back: re-run an old release",
    "```",
    "",
    "`release.yml` resolves the tagged commit's image to a digest, copies it into",
    "the production registry, and deploys that digest — never a tag. There is no",
    "local command that deploys production, deliberately: attempting one fails at",
    "Google's door, not at a policy. The workflow goes **red** until bootstrap's",
    "variables exist — alongside the two above it needs",
    "`RUNWAY_PRODUCTION_STATE_BACKEND`, the Pulumi backend URL for the production",
    "stack.",
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
    "// Promotion is an artifact moving, not a rebuild. Staging runs a tag;",
    "// production runs the digest that tag resolved to, written by CI at",
    "// promotion. A digest wins when both are set -- which is a branch on",
    "// configuration, never on stack name, so both stacks run this same file.",
    'const config = new pulumi.Config();',
    'const imageDigest = config.get("imageDigest");',
    'const imageTag = config.get("imageTag");',
    "if (imageDigest === undefined && imageTag === undefined) {",
    "  throw new Error(",
    '    "Set imageDigest (production, promoted by CI) or imageTag (staging).",',
    "  );",
    "}",
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
    // Suffixed, not bare: a GCP service account id must be 6-30 characters, and
    // a short service name like "demo" is only 4. "-runtime" also says what the
    // identity is for, next to the CI deployer account in the same project.
    `  accountId: "${name}-runtime",`,
    "  project,",
    "});",
    "",
    "// Private by default: internal load-balancer ingress, no invoker binding,",
    "// deletion protection on. Reaching it needs a load balancer, which is the",
    "// secure default working rather than a misconfiguration.",
    `const service = new SecureContainerService("${name}", {`,
    "  location,",
    "  image:",
    "    imageDigest !== undefined",
    "      ? pulumi.interpolate`${images.imagePrefix}/" + name + "@${imageDigest}`",
    "      : pulumi.interpolate`${images.imagePrefix}/" + name + ":${imageTag}`,",
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
