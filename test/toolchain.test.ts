import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repo-level toolchain invariants.
 *
 * These assertions moved here from packages/runway-cli when the repo became an
 * npm-workspaces monorepo (C1). They were never really about the CLI: the
 * linter, its config, and the package manager are properties of the workspace
 * root, and after the move the root is the only place they are true. What stays
 * in the CLI package is what is genuinely per-package — its own compiler and
 * test-runner pins, and its bin entry.
 */

const root = join(__dirname, "..");

interface PackageJson {
  readonly devDependencies: Record<string, string>;
}

interface TasksJson {
  readonly tasks: Record<string, { readonly steps: { readonly exec?: string }[] }>;
}

interface FilesJson {
  readonly files: string[];
}

const read = (...segments: string[]): string =>
  readFileSync(join(root, ...segments), "utf-8");

const packageJson = (): PackageJson => JSON.parse(read("package.json")) as PackageJson;
const tasksJson = (): TasksJson => JSON.parse(read(".projen", "tasks.json")) as TasksJson;
const filesJson = (): FilesJson => JSON.parse(read(".projen", "files.json")) as FilesJson;

describe("linter", () => {
  const lintCommand = (task: string): string =>
    tasksJson()
      .tasks[task].steps.map((step) => step.exec ?? "")
      .join(" ");

  it("pins oxlint — ESLint cannot run on TypeScript 7", () => {
    expect(packageJson().devDependencies.oxlint).toBe("1.80.0");
  });

  it("pins oxlint-tsgolint so type-aware rules are available", () => {
    expect(packageJson().devDependencies["oxlint-tsgolint"]).toBe("7.0.2001");
  });

  it("registers a lint task that gates on warnings", () => {
    const command = lintCommand("lint");
    expect(command).toContain("oxlint");
    expect(command).toContain("--type-aware");
    // Without this, oxlint reports and exits 0 — a report, not a gate.
    expect(command).toContain("--deny-warnings");
  });

  it("registers a lint:fix task that autofixes instead of gating", () => {
    const command = lintCommand("lint:fix");
    expect(command).toContain("--fix");
    expect(command).not.toContain("--deny-warnings");
  });

  it("generates .oxlintrc.json through projen rather than by hand", () => {
    expect(existsSync(join(root, ".oxlintrc.json"))).toBe(true);
    // projen's usual "//" marker cannot be used here — oxlint rejects unknown
    // config fields — so ownership is asserted from projen's own file registry.
    expect(filesJson().files).toContain(".oxlintrc.json");
  });

  it("keeps a single lint config at the root — oxlint discovers it by walking up", () => {
    expect(existsSync(join(root, "packages", "runway-cli", ".oxlintrc.json"))).toBe(false);
  });
});

describe("package manager", () => {
  it("is npm — projen defaults to yarn when packageManager is unset", () => {
    expect(existsSync(join(root, "package-lock.json"))).toBe(true);
  });

  it.each(["yarn.lock", "pnpm-lock.yaml"])("has no competing %s", (lockfile) => {
    expect(existsSync(join(root, lockfile))).toBe(false);
  });

  it("keeps exactly one lockfile — a nested one would silently defeat hoisting", () => {
    expect(existsSync(join(root, "packages", "runway-cli", "package-lock.json"))).toBe(false);
  });
});

describe("npm config", () => {
  const npmrc = (): string => read(".npmrc");

  it("sets legacy-peer-deps, without which @pulumi/pulumi cannot install at all", () => {
    // @pulumi/pulumi declares peerDependencies typescript ">= 3.8.3 < 7".
    // TypeScript 7.0.2 is outside that range, so a plain `npm install` fails
    // ERESOLVE. Both peers are optional, so nothing needs them at runtime --
    // the range is stale metadata, not a real constraint.
    expect(npmrc()).toMatch(/^legacy-peer-deps\s*=\s*true$/m);
  });

  it("explains itself in the file, where someone hitting the failure will look", () => {
    // The cost of this flag is that it disables peer checking repo-wide. A bare
    // key would leave the next reader to rediscover why it is here.
    expect(npmrc()).toMatch(/@pulumi\/pulumi/);
    expect(npmrc()).toMatch(/#/);
  });

  it("is projen-generated, not hand-written", () => {
    expect(filesJson().files).toContain(".npmrc");
  });
});

