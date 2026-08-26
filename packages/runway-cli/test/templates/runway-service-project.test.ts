import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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

/**
 * Source with comments removed.
 *
 * src/server/index.ts explains in prose why it resolves from the working
 * directory *instead of* `__dirname`, and that explanation must not trip the
 * rule it documents.
 */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** A port nothing else holds: bind zero, read what the OS gave back, release it. */
const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        reject(new Error("expected a TCP address"));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });

/**
 * Start the generated repo's compiled server the way the Dockerfile does —
 * `node lib/server/index.js`, port from the environment.
 *
 * Polled rather than slept: the server prints nothing on listen, so there is no
 * line to wait for, and a fixed sleep is either slower than it needs to be or
 * flaky on a loaded machine.
 */
const startServer = async (dir: string): Promise<{ base: string; stop: () => void }> => {
  const port = await freePort();
  const child = spawn("node", ["lib/server/index.js"], {
    cwd: dir,
    // NODE_ENV must not be "test" here. The generated server guards listen() on
    // it so its own vitest suite can import the module without binding a port —
    // and vitest sets it in *this* process, so an inherited environment makes
    // the server exit 0 without ever listening. The image runs it without.
    env: { ...process.env, NODE_ENV: "production", PORT: String(port) },
    stdio: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  const stop = (): void => {
    child.kill();
  };

  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`server exited with code ${child.exitCode} before it listened`);
    }
    try {
      await fetch(`${base}/healthz`);
      return { base, stop };
    } catch {
      await delay(25);
    }
  }

  stop();
  throw new Error(`server at ${base} did not start within 5s`);
};

/**
 * The root-relative URLs a document pulls in.
 *
 * Read out of the built HTML rather than hardcoded, because the whole point is
 * to assert what vite actually emitted — including the hashed filenames and the
 * directory it chose to put them in.
 */
const assetsReferencedBy = (html: string): string[] =>
  [...html.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map(([, href]) => href ?? "");

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
      // Keeps the laptop's node_modules and stale build output from leaking
      // into the image the Dockerfile builds.
      ".dockerignore",
      ".gitattributes",
      // The PR gate, and the only file projen's GitHub integration is allowed
      // to add; the upgrade, PR-lint, mergify and PR-template defaults are off.
      ".github/workflows/build.yml",
      // The only route to production: a tag push, or a dispatch on a tag ref.
      ".github/workflows/release.yml",
      ".gitignore",
      ".npmignore",
      ".npmrc",
      ".oxlintrc.json",
      ".projen/deps.json",
      ".projen/files.json",
      ".projen/tasks.json",
      ".projenrc.ts",
      // The deployable artifact release-path promotes; two stages, and the
      // ship stage carries no node_modules at all.
      "Dockerfile",
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
      // SS-02's enforcement point: projen-managed, so removing it is a visible
      // edit to .projenrc.ts rather than a quiet rm.
      "test/production-image.test.ts",
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

  it("LD-07: registers a dev task that no gate task can reach", () => {
    const tasks = JSON.parse(read(".projen/tasks.json")) as {
      tasks: Record<string, { steps?: { spawn?: string; exec?: string }[] }>;
    };

    expect(tasks.tasks.dev).toBeDefined();

    // Transitively, not just one level down: `build` spawns `test`, which
    // spawns `lint`, and a watcher anywhere under that is a CI job that never
    // exits. Walk the whole tree rather than trusting the shape of it.
    const reachable = (name: string, seen = new Set<string>()): Set<string> => {
      if (seen.has(name)) return seen;
      seen.add(name);
      for (const step of tasks.tasks[name]?.steps ?? []) {
        if (step.spawn !== undefined) reachable(step.spawn, seen);
      }
      return seen;
    };

    for (const gate of ["build", "compile", "test", "package"]) {
      expect([...reachable(gate)]).not.toContain("dev");
    }
  });

  /**
   * The regression guard for the bug `npm run dev` found.
   *
   * `node --watch` runs src/ straight from TypeScript, and Node infers the
   * module system from the file's syntax — so an `import` anywhere makes the
   * file an ES module, where `__dirname` does not exist. `tsc` emits CommonJS
   * for lib/, so the same source works compiled and crashes in the dev loop.
   * `import.meta` is the mirror image: fine in dev, a syntax error in the
   * CommonJS output the image runs.
   *
   * Neither can be used in generated src/ until the scaffold commits to one
   * module system. Asserted, because the failure only appears at runtime and
   * only in one of the two paths.
   */
  it("LD-03: generated src/ uses neither __dirname nor import.meta", () => {
    const offenders = tree
      .filter((file) => file.startsWith("src/"))
      .filter((file) => /\b__dirname\b|\bimport\.meta\b/.test(withoutComments(read(file))));

    expect(offenders).toEqual([]);
  });

  it("LD-04: proxies server routes so development has one origin", () => {
    const config = read("vite.config.ts");

    // The alternative to a proxy is an API base URL in the environment, which
    // is a dev-only value that reaches production code.
    expect(config).toContain("proxy");
    expect(config).toContain('"/api"');
    expect(config).toContain('"/healthz"');

    // No API base URL anywhere in the service's own source. Not the same as
    // "no env var at all": the server reads PORT because Cloud Run supplies it,
    // and guards listen() on NODE_ENV so its own suite can import the module.
    // Those are runtime facts, not a development branch.
    for (const file of tree.filter((f) => f.startsWith("src/"))) {
      expect(read(file)).not.toMatch(/API_(BASE_)?URL|VITE_API|BASE_URL/);
      expect(read(file)).not.toMatch(/NODE_ENV\s*===?\s*["'](development|production)["']/);
    }
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

  // "serves the built client from the same process" used to live here as a
  // regex over src/server/index.ts. It is now asserted by fetching the page and
  // its assets from a running server — see LD-09 under "build-out". A grep left
  // beside that would get cited as coverage it never was.

  it("ships a client that renders something", () => {
    expect(read("src/client/App.tsx")).toMatch(/<h1|return \(/);
    expect(read("src/client/main.tsx")).toContain("createRoot");
  });

  it("ships passing tests for both halves, green from commit one", () => {
    expect(read("test/server.test.ts")).toMatch(/\b(it|test)\(/);
    expect(read("test/App.test.tsx")).toMatch(/\b(it|test)\(/);
  });

  it("SS-02: emits a digest guard the team must edit .projenrc.ts to remove", () => {
    const guard = read("test/production-image.test.ts");

    // projen-managed, not a sample: a deleted guard comes back on `npx projen`.
    expect(guard).toContain("~~ Generated by projen");
    expect(guard).toContain("imageTag");
    expect(guard).toContain("sha256:[0-9a-f]{64}");
  });

  it("SS-02: the pristine production config carries no image reference at all", () => {
    // The honest pre-promotion state: CI writes imageDigest at promotion, and
    // a tag here would leave production tracking something mutable.
    expect(read("infra/Pulumi.production.yaml")).not.toMatch(/imageTag|imageDigest/);
  });

  it("explains itself in the README rather than shipping an empty one", () => {
    const readme = read("README.md");
    expect(readme).toMatch(/^# demo$/m);
    // The one file a user is meant to hand-edit must be named.
    expect(readme).toContain(".projenrc.ts");
  });
});

describe("build-out", () => {
  /**
   * One scaffold, installed and built once, shared by everything below.
   *
   * Hoisted out of the single test it used to live in because LD-09 needs the
   * *built* client, and a second `npm install` would roughly double the slowest
   * thing in the pull-request gate. `npm run build` runs here rather than in
   * the test below for the same reason — a failure still fails the whole
   * describe, which is what the test asserted anyway.
   */
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "runway-buildout-"));
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
    ] as const) {
      execFileSync(cmd, args, { cwd: dir, stdio: "pipe" });
    }
  }, 600_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * SS-02, failure-injected. The guard exists to fail; a guard only ever seen
   * passing is indistinguishable from no guard. Each case edits the production
   * stack config the way a team would — then the generated repo's own suite
   * must reach the verdict, because that is where the control actually runs.
   */
  describe("SS-02: a tag on production fails the generated build", () => {
    const configPath = (): string => join(dir, "infra", "Pulumi.production.yaml");
    const guardVerdict = (): "pass" | "fail" => {
      try {
        execFileSync("npx", ["vitest", "run", "test/production-image.test.ts"], {
          cwd: dir,
          stdio: "pipe",
        });
        return "pass";
      } catch {
        return "fail";
      }
    };

    it.each([
      ["a tag", "  imageTag: v2", "fail"],
      // The namespaced form `pulumi config set` writes; the guard must not
      // depend on which of the two spellings the drift arrives in.
      ["a digest that is really a tag", "  demo:imageDigest: v2", "fail"],
      ["the digest CI writes at promotion", `  demo:imageDigest: sha256:${"a".repeat(64)}`, "pass"],
    ] as const)("%s → %s", { timeout: 120_000 }, (_case, line, expected) => {
      const original = readFileSync(configPath(), "utf-8");
      writeFileSync(configPath(), original + line + "\n");
      try {
        expect(guardVerdict()).toBe(expected);
      } finally {
        writeFileSync(configPath(), original);
      }
    });
  });

  // The test that matters: anything less proves only that we can write files.
  it("builds, tests and lints unmodified in a temp directory", { timeout: 600_000 }, () => {
    for (const [cmd, args] of [
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
  });

  /**
   * LD-09. What replaced a grep.
   *
   * The assertion this supersedes matched /dist|client/ against the *source
   * text* of src/server/index.ts. It passed whether or not a single byte ever
   * reached a browser, which is the only thing anyone actually cares about.
   *
   * So: build the client, start the real server, and ask it for the page and
   * for every asset that page references.
   */
  describe("LD-09: the built client is served", () => {
    let base: string;
    let stop: () => void;

    beforeAll(async () => {
      const started = await startServer(dir);
      base = started.base;
      stop = started.stop;
    }, 60_000);

    afterAll(() => {
      stop?.();
    });

    it("serves the document vite built, not merely a 200", async () => {
      const response = await fetch(base + "/");

      expect(response.status).toBe(200);
      const body = await response.text();
      // The built document, not the source index.html: vite rewrites the
      // module script into a bundled asset reference.
      expect(body).toContain('<div id="root">');
      expect(assetsReferencedBy(body).length).toBeGreaterThan(0);
    });

    it("serves every asset the document references", async () => {
      const body = await (await fetch(base + "/")).text();
      const assets = assetsReferencedBy(body);

      const statuses = await Promise.all(
        assets.map(async (href) => [href, (await fetch(base + href)).status] as const),
      );

      // Named individually: "some asset 404s" is a bug report nobody can act on.
      expect(statuses.filter(([, status]) => status !== 200)).toEqual([]);
    });

    it("still serves the health endpoint", async () => {
      const response = await fetch(base + "/healthz");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "ok" });
    });

    /**
     * Failure injection, without a rebuild: take the built client away and the
     * page must stop being served. A serving test that cannot fail on missing
     * build output is not evidence — it is the same silent pass this whole
     * task exists to remove.
     */
    it("fails when the built client is not where the server looks", async () => {
      const built = join(dir, "dist", "client");
      const moved = join(dir, "dist", "client.injected");
      renameSync(built, moved);
      try {
        expect((await fetch(base + "/")).status).not.toBe(200);
      } finally {
        renameSync(moved, built);
      }
    });

    /**
     * The other direction. A server answering index.html for every path passes
     * the weak version of the asset test above while rendering a blank page, so
     * prove it refuses something it was never given.
     */
    it("does not answer 200 for a path it never emitted", async () => {
      const response = await fetch(base + "/nothing-was-ever-emitted-here.js");

      expect(response.status).not.toBe(200);
    });

    /**
     * The containment guard, asserted rather than assumed.
     *
     * `basename()` used to make traversal structurally impossible; serving
     * nested asset paths gave that up, so the bound that replaced it has to be
     * tested. Percent-encoded, deliberately: a literal `/../../` is collapsed
     * by URL parsing before it ever leaves fetch, so it would prove nothing.
     *
     * 403 exactly, not "not 200" — a 404 would pass a weaker assertion while
     * meaning the file merely happened to be absent.
     */
    it.each([
      ["encoded separators", "/..%2f..%2fpackage.json"],
      ["encoded dots and separators", "/%2e%2e%2f%2e%2e%2fpackage.json"],
      ["a traversal below the asset directory", "/assets%2f..%2f..%2fpackage.json"],
    ])("refuses %s", async (_case, path) => {
      const response = await fetch(base + path);

      expect(response.status).toBe(403);
    });
  });
});

describe("stack configuration", () => {
  const stackConfig = (env: string): string => read(`infra/Pulumi.${env}.yaml`);

  it.each([
    ["staging", "demo-staging"],
    ["production", "demo-production"],
  ])("SS-06: %s targets the derived project %s", (env, projectId) => {
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

  it("SS-05: requires the region rather than defaulting it, and bakes in no literal", () => {
    // SPEC-runway-cli forbids baking a region default into generated source,
    // and the default is the worse failure: an unset region deploys silently to
    // Belgium instead of stopping. require() turns a wrong answer into a
    // missing one. gcp:project is already required, so this costs no working
    // configuration -- a fresh scaffold could never preview without config.
    expect(infra()).toContain('gcpConfig.require("region")');
    // The spec's own greppable form: no region, no project path, no credential
    // shape anywhere in the generated program.
    expect(infra()).not.toMatch(/europe-west\d|projects\/|AIza|-----BEGIN/);
  });

  it("SS-03: the program opens nothing to the public", () => {
    // The generated example never exercises the opt-out. Private-by-default is
    // CR-01's guarantee at runtime; this asserts the scaffold does not teach
    // the escape hatch on day one -- an example carrying publicAccess would be
    // copied precisely because it is the example.
    expect(infra()).not.toMatch(/publicAccess|allUsers|ServiceIamMember/);
  });

  it("SS-04: the stack runs precompiled JavaScript, never ts-node", () => {
    // typescript: false is load-bearing: Pulumi's ts-node cannot load
    // TypeScript 7 at all, and even where it could, transpiling the @pulumi/gcp
    // declaration graph was measured at over two minutes without completing.
    const runtime = read("infra/Pulumi.yaml");
    expect(runtime).toContain("typescript: false");
    expect(runtime).toContain("main: lib/index.js");
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

  it("SS-01: prefers a digest over a tag, without branching on stack name", () => {
    // The program is identical for both stacks. Preferring a digest when
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

describe("container image", () => {
  // The artifact release-path promotes. Until this existed nothing built an
  // image at all — the registry component created a repository nothing wrote
  // to, which was recorded as the module's blocker.

  it("emits a two-stage Dockerfile whose ship stage installs nothing", () => {
    const dockerfile = read("Dockerfile");
    const stages = dockerfile.split(/^FROM /m).slice(1);

    expect(stages).toHaveLength(2);
    // The generated server imports only Node builtins and the client is
    // bundled by vite, so the shipped image carries no node_modules — there
    // is nothing to install, and therefore no registry credential to need.
    expect(stages[1]).not.toMatch(/npm|node_modules/);
  });

  it("mounts the registry credential as a build secret, never a layer", () => {
    const dockerfile = read("Dockerfile");

    expect(dockerfile).toContain("--mount=type=secret");
    expect(dockerfile).not.toMatch(/_authToken|ya29\./);
  });

  it("runs the compiled server as the container command", () => {
    expect(read("Dockerfile")).toContain('CMD ["node", "lib/server/index.js"]');
  });

  it("keeps host artifacts out of the build context", () => {
    // Without this, COPY . . drags in the developer's node_modules and stale
    // lib/ and dist/ — the image would quietly ship whatever the laptop last
    // built instead of what the builder stage compiles.
    const dockerignore = read(".dockerignore");
    for (const entry of ["node_modules", "lib", "dist"]) {
      expect(dockerignore).toContain(entry);
    }
  });

  it("documents the local build — credential and platform included", () => {
    // --platform linux/amd64: Cloud Run rejects an arm64 manifest at deploy
    // time, after the push, against an immutable tag. The README says so
    // because that tag is burned forever.
    expect(read("README.md")).toContain(
      "docker build --platform linux/amd64 --secret",
    );
  });
});


describe("federated CI leaves no residue", () => {
  it("gitignores the auth action's credential file", () => {
    // Untracked, the mutation check would diff it and upload it in
    // repo.patch — a credential file in a build artifact. Observed on the
    // first federated run.
    expect(read(".gitignore")).toContain("gha-creds-*.json");
  });
});

describe("regeneration keeps its region", () => {
  it("emits the region into .projenrc.ts", () => {
    // The repo re-runs its own projenrc through type stripping, which checks
    // nothing: without the region persisted here, regeneration rebuilt every
    // workflow against undefined-docker.pkg.dev. Observed in CI, silently.
    expect(read(".projenrc.ts")).toContain('region: "europe-west1"');
  });

  it("refuses construction without a region, loudly", () => {
    expect(
      () =>
        new RunwayServiceProject({
          name: "demo",
        } as unknown as ConstructorParameters<typeof RunwayServiceProject>[0]),
    ).toThrow(/region is required/);
  });
});
