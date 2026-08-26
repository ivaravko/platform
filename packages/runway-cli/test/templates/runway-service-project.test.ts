import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunwayServiceProject } from "../../src";
import { withLocalPackages } from "../support/local-links";

/**
 * Task 2: the scaffold must build, and it must carry the TypeScript 7 survival
 * kit. Three of those constraints are the difference between a generated repo
 * that works and one that cannot run its first command, so each is asserted
 * here rather than left to review.
 */

/** Every file projen emits, relative and posix-style, excluding installed deps. */
const treeOf = (root: string): string[] => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      if (entry === "node_modules" || entry === ".git") return [];
      const full = join(dir, entry);
      return statSync(full).isDirectory()
        ? walk(full)
        : [relative(root, full).split(sep).join("/")];
    });
  return walk(root).toSorted();
};

/**
 * Criterion 7 excludes "lockfiles and generated config". Defined positively
 * rather than by exclusion, because the rule it encodes is "every generated
 * line is a line someone must read" — and nobody reads .gitignore or a tsconfig.
 * Counted: the service's own code, plus the two files a user is invited to open.
 */
const isHumanRead = (file: string): boolean =>
  file.startsWith("src/") ||
  (file.startsWith("test/") && file.endsWith(".test.ts")) ||
  file === "README.md" ||
  file === ".projenrc.ts" ||
  file === ".oxlintrc.json";

let outdir: string;
let tree: string[];
const read = (file: string): string => readFileSync(join(outdir, file), "utf-8");

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "runway-scaffold-"));
  // postSynthesize would run a real `npm install` per synth; the build-out test
  // below does that deliberately, but the fast assertions must not.
  process.env.PROJEN_DISABLE_POST = "true";
  new RunwayServiceProject({ name: "demo", outdir, region: "europe-west1" }).synth();
  tree = treeOf(outdir);
});

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("scaffold file tree", () => {
  it("emits exactly the expected files and nothing else", () => {
    expect(tree).toEqual([
      ".gitattributes",
      // The only file projen's GitHub integration is allowed to add; the
      // release, upgrade, PR-lint, mergify and PR-template defaults are off.
      ".github/workflows/build.yml",
      ".gitignore",
      ".npmignore",
      ".npmrc",
      ".oxlintrc.json",
      ".projen/deps.json",
      ".projen/files.json",
      ".projen/tasks.json",
      ".projenrc.ts",
      "README.md",
      "index.html",
      // The load-bearing artifact: a worked example composing all three
      // components, with no raw gcp.* resource anywhere in it.
      "infra/Pulumi.production.yaml",
      "infra/Pulumi.staging.yaml",
      "infra/Pulumi.yaml",
      "infra/index.ts",
      "infra/tsconfig.json",
      "package.json",
      "projenrc/tsconfig.json",
      "src/client/App.tsx",
      "src/client/main.tsx",
      "src/server/index.ts",
      "test/App.test.tsx",
      "test/server.test.ts",
      "test/tsconfig.json",
      "tsconfig.json",
      "vite.config.ts",
    ]);
  });

  it("carries no TODO or FIXME markers", () => {
    const offenders = tree.filter((file) => /TODO|FIXME/.test(read(file)));
    expect(offenders).toEqual([]);
  });

  it("stays within the 300-line budget of criterion 7", () => {
    const counted = tree.filter(isHumanRead);
    const lines = counted.reduce((n, f) => n + read(f).split("\n").length, 0);

    // Surfaced on failure so the fix is obvious rather than a hunt.
    const breakdown = counted
      .map((f) => `${String(read(f).split("\n").length).padStart(4)}  ${f}`)
      .join("\n");
    expect(lines, `generated lines:\n${breakdown}`).toBeLessThanOrEqual(300);
  });
});

describe("outdir default", () => {
  it("falls back to a directory named after the service", () => {
    // The documented default, and not an idle one: it is precisely what caused
    // a scaffold to regenerate a nested copy of itself in Task 2, because the
    // emitted .projenrc.ts omitted outdir. Left untested, that default is the
    // one nobody exercises until it misbehaves.
    const dir = mkdtempSync(join(tmpdir(), "runway-outdir-"));
    const previous = process.cwd();
    try {
      process.chdir(dir);
      new RunwayServiceProject({ name: "defaulted", region: "europe-west1" }).synth();
      expect(readdirSync(join(dir, "defaulted"))).toContain(".projenrc.ts");
    } finally {
      process.chdir(previous);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TypeScript 7 survival kit", () => {
  it("runs .projenrc.ts through Node, not ts-node, which throws on TS 7", () => {
    const { tasks } = JSON.parse(read(".projen/tasks.json")) as {
      tasks: Record<
        string,
        { steps?: { exec?: string; execArgs?: string[] }[] }
      >;
    };
    // The nodejs runner emits execArgs, not exec.
    const defaultTask = (tasks.default.steps ?? [])
      .map((s) => [s.exec ?? "", ...(s.execArgs ?? [])].join(" "))
      .join(" ");
    expect(defaultTask).toContain("node");
    expect(defaultTask).toContain(".projenrc.ts");
    expect(defaultTask).not.toContain("ts-node");
  });

  it("ships its own .oxlintrc.json — nothing to inherit outside the monorepo", () => {
    expect(tree).toContain(".oxlintrc.json");
    expect(JSON.parse(read(".oxlintrc.json"))).toHaveProperty("categories");
  });

  it("pins oxlint and disables eslint, which cannot install on TS 7", () => {
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies.oxlint).toBeDefined();
    expect(pkg.devDependencies["oxlint-tsgolint"]).toBeDefined();
    const eslintDeps = Object.keys(pkg.devDependencies).filter((d) =>
      d.includes("eslint"),
    );
    expect(eslintDeps).toEqual([]);
  });

  it("registers lint and lint:fix tasks", () => {
    const { tasks } = JSON.parse(read(".projen/tasks.json")) as {
      tasks: Record<string, { steps?: { exec?: string }[] }>;
    };
    expect((tasks.lint.steps ?? [])[0].exec).toContain("--deny-warnings");
    expect((tasks["lint:fix"].steps ?? [])[0].exec).toContain("--fix");
  });

  it("forwards args to vitest — without receiveArgs projen drops them silently", () => {
    const { tasks } = JSON.parse(read(".projen/tasks.json")) as {
      tasks: Record<string, { steps?: { exec?: string; receiveArgs?: boolean }[] }>;
    };
    const vitest = (tasks.test.steps ?? []).find((s) => s.exec?.includes("vitest"));
    expect(vitest?.receiveArgs).toBe(true);
  });

  it("resolves @runway/* by published version, not by a path on one laptop", () => {
    // E9. Until the packages were published these were `file:` links to
    // absolute paths inside the developer's home directory, so a generated repo
    // built on the machine that made it and nowhere else -- not on a colleague's
    // checkout, not in CI, and not inside a container. That is what blocked the
    // Dockerfile, and it is the reason this module exists.
    const pkg = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(pkg.devDependencies["@runway/cli"]).toMatch(/^\^?\d+\.\d+\.\d+$/);
    expect(pkg.dependencies["@runway/gcp-components"]).toMatch(/^\^?\d+\.\d+\.\d+$/);
  });

  it("carries no absolute path anywhere in package.json", () => {
    // The narrower assertion above checks two known keys. This one catches a
    // third link added later, and any machine-specific path at all.
    expect(read("package.json")).not.toMatch(/file:|\/Users\/|\/home\//);
  });
});

describe("scaffold content", () => {
  it("serves a health endpoint", () => {
    expect(read("src/server/index.ts")).toMatch(/healthz/);
  });

  it("serves the built client from the same process", () => {
    // One container: the SPA and the API share an image, so infra/ provisions
    // one Cloud Run service and nothing about the stack changes.
    expect(read("src/server/index.ts")).toMatch(/dist|client/);
  });

  it("ships a client that renders something", () => {
    expect(read("src/client/App.tsx")).toMatch(/<h1|return \(/);
    expect(read("src/client/main.tsx")).toContain("createRoot");
  });

  it("ships passing tests for both halves, green from commit one", () => {
    expect(read("test/server.test.ts")).toMatch(/\b(it|test)\(/);
    expect(read("test/App.test.tsx")).toMatch(/\b(it|test)\(/);
  });

  it("explains itself in the README rather than shipping an empty one", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/^# demo$/m);
    // The one file a user is meant to hand-edit must be named.
    expect(readme).toContain(".projenrc.ts");
  });
});

describe("build-out", () => {
  // The test that matters: anything less proves only that we can write files.
  it(
    "builds, tests and lints unmodified in a temp directory",
    { timeout: 600_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "runway-buildout-"));
      try {
        withLocalPackages(() =>
          new RunwayServiceProject({
            name: "demo",
            outdir: dir,
            region: "europe-west1",
          }).synth(),
        );
        // Install precedes projen: .projenrc.ts imports projen and cannot run
        // before node_modules exists.
        for (const [cmd, args] of [
          ["npm", ["install"]],
          ["npx", ["projen"]],
          ["npm", ["run", "build"]],
          ["npm", ["test"]],
          ["npm", ["run", "lint"]],
        ] as const) {
          execFileSync(cmd, args, { cwd: dir, stdio: "pipe" });
        }
        // Idempotence: a second synth must change nothing.
        const before = treeOf(dir).map((f) => `${f}:${readFileSync(join(dir, f), "utf-8")}`);
        execFileSync("npx", ["projen"], { cwd: dir, stdio: "pipe" });
        const after = treeOf(dir).map((f) => `${f}:${readFileSync(join(dir, f), "utf-8")}`);
        expect(after).toEqual(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("stack configuration", () => {
  const stackConfig = (env: string): string => read(`infra/Pulumi.${env}.yaml`);

  it.each([
    ["staging", "demo-staging"],
    ["production", "demo-production"],
  ])("%s targets the derived project %s", (env, projectId) => {
    // Derived, not passed: the scaffold knows the name, so neither a flag nor a
    // config file has to carry an identifier between two commands.
    expect(stackConfig(env)).toContain(`gcp:project: ${projectId}`);
  });

  it.each(["staging", "production"])("%s carries the region", (env) => {
    // The program requires gcp:region. Without it here, every generated repo
    // would fail its first preview on config the scaffold could have written.
    expect(stackConfig(env)).toContain("gcp:region: europe-west1");
  });

  it("gives staging a tag to start from", () => {
    // Staging is where a tag is fine: it is rebuilt constantly and nothing
    // downstream inherits what it ran.
    expect(stackConfig("staging")).toContain("imageTag:");
  });

  it("gives production no image at all until something is promoted", () => {
    // There is no digest at scaffold time -- the image does not exist yet. A
    // tag here would be worse than nothing: it would satisfy the config and
    // leave production tracking something mutable, which is the failure digest
    // promotion exists to prevent. CI writes imageDigest at promotion.
    expect(stackConfig("production")).not.toContain("imageTag");
    expect(stackConfig("production")).not.toContain("imageDigest");
  });

  it("gives the two environments different projects", () => {
    expect(stackConfig("staging")).not.toEqual(stackConfig("production"));
  });
});

describe("infra program", () => {
  const infra = (): string => read("infra/index.ts");

  it("requires the region rather than defaulting it", () => {
    // SPEC-runway-cli forbids baking a region default into generated source,
    // and the default is the worse failure: an unset region deploys silently to
    // Belgium instead of stopping. require() turns a wrong answer into a
    // missing one. gcp:project is already required, so this costs no working
    // configuration -- a fresh scaffold could never preview without config.
    expect(infra()).toContain('gcpConfig.require("region")');
    expect(infra()).not.toMatch(/europe-west\d/);
  });

  it("composes all three components", () => {
    for (const component of [
      "SecureArtifactRepository",
      "SecureServiceAccount",
      "SecureContainerService",
    ]) {
      expect(infra(), component).toContain(component);
    }
  });

  it("contains no `gcp.` at all, so the no-raw-resource claim is greppable", () => {
    // Stricter than the rule needs, deliberately. A pulumi.Config named `gcp`
    // would satisfy the resource check while making the file read as though it
    // used the provider.
    expect(infra()).not.toMatch(/\bgcp\./);
  });

  it("declares no raw gcp.* resource", () => {
    // The scaffold must not teach the habit the product exists to prevent. A
    // worked example that reaches for gcp.cloudrunv2.Service undoes every
    // guardrail by demonstration.
    expect(infra()).not.toMatch(/\bgcp\.(cloudrunv2|serviceaccount|artifactregistry|projects)\./);
  });

  it("imports the components package, not the provider, for resources", () => {
    expect(infra()).toContain('from "@runway/gcp-components"');
  });

  it("passes the identity as a component, never as an email string", () => {
    // CR-04 is a type-level guarantee now. An example that hand-wrote an email
    // would not compile, but it would still teach the wrong shape.
    expect(infra()).toMatch(/serviceAccount: identity/);
    expect(infra()).not.toMatch(/serviceAccountEmail/);
  });

  it("suffixes the service account id past GCP's six-character minimum", () => {
    // Found by a real preview, not by reading: "demo" is 4 characters and the
    // provider rejects it. The suffix keeps every valid service name -- 1 to 19
    // characters -- inside the 6-30 the API allows.
    expect(infra()).toContain('accountId: "demo-runtime"');
  });

  it("prefers a digest over a tag, without branching on stack name", () => {
    // SS-01: the program is identical for both stacks. Preferring a digest when
    // one is configured is a branch on config, not on environment -- production
    // gets a digest because CI sets one, not because the program knows it is
    // production.
    const source = infra();
    expect(source).toContain("imageDigest");
    expect(source).not.toMatch(/stack\s*===|getStack\(\)/);
  });

  it("warns that immutable tags mean releasing a new tag, not moving one", () => {
    // AR-01 makes `latest` work exactly once. Someone will reach for it.
    expect(infra()).toMatch(/immutable/i);
  });

  it("is compiled, which both produces what Pulumi runs and typechecks it", () => {
    const tasks = JSON.parse(read(".projen/tasks.json")) as {
      tasks: Record<string, { steps: { exec?: string; spawn?: string }[] }>;
    };
    const compileInfra = tasks.tasks["compile:infra"].steps
      .map((s) => s.exec ?? "")
      .join(" ");
    expect(compileInfra).toContain("infra/tsconfig.json");
    expect(compileInfra).not.toContain("--noEmit");
    expect(tasks.tasks.compile.steps.some((s) => s.spawn === "compile:infra")).toBe(true);
  });

  it("runs the compiled output, never the source", () => {
    // Pulumi runs a .ts program through ts-node with type checking on, which
    // here means type-checking the whole @pulumi/gcp declaration graph on every
    // invocation -- measured at over two minutes without completing, on both
    // Pulumi's vendored ts-node 7 and a current ts-node 10. Compiled, the same
    // preview finishes in seconds.
    const yaml = read("infra/Pulumi.yaml");
    expect(yaml).toMatch(/typescript:\s*false/);
    expect(yaml).toMatch(/main:\s*lib\/index\.js/);
  });
});

describe("scaffold toolchain", () => {
  it("pins TypeScript 7, matching the platform", () => {
    const pkg = JSON.parse(read("package.json")) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies.typescript).toBe("7.0.2");
  });

  it("ships .npmrc, because @pulumi/* peer-caps TypeScript below 7", () => {
    // The cost of matching the platform's compiler: npm refuses to resolve
    // @pulumi/pulumi against TypeScript 7 without this, so a generated repo
    // cannot install at all. Peer checking is disabled repo-wide as a result.
    expect(tree).toContain(".npmrc");
    expect(read(".npmrc")).toContain("legacy-peer-deps=true");
  });

  it("points the @runway scope at Artifact Registry, and carries no token", () => {
    // A published version is unresolvable without knowing where it lives, so
    // the scope mapping ships with the repo. The credential does not: it is
    // short-lived, per-developer, and belongs in ~/.npmrc — this file is
    // committed, and a token in it would be a secret in git.
    const npmrc = read(".npmrc");
    expect(npmrc).toContain("@runway:registry=");
    expect(npmrc).toContain("npm.pkg.dev");
    expect(npmrc).not.toMatch(/_authToken|_auth=|ya29\./);
  });

  it("depends on the components package", () => {
    const pkg = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).toContain("@runway/gcp-components");
  });
});

