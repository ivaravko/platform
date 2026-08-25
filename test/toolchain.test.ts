import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Task 1's acceptance criteria as executable checks.
 *
 * The toolchain is the prototype's flagged risk: TypeScript 7 shipped days before
 * the projen version we pin, and projen silently falls back to yarn when the
 * package manager is left unset. Both failures are invisible until something
 * downstream breaks, so they are asserted here rather than eyeballed once.
 */

const root = join(__dirname, "..");

interface PackageJson {
  readonly devDependencies: Record<string, string>;
  readonly bin?: Record<string, string>;
}

interface TasksJson {
  readonly tasks: Record<string, { readonly steps: { readonly exec?: string }[] }>;
}

interface FilesJson {
  readonly files: string[];
}

const read = (...segments: string[]): string =>
  readFileSync(join(root, ...segments), "utf-8");

const packageJson = (): PackageJson =>
  JSON.parse(read("package.json")) as PackageJson;

const tasksJson = (): TasksJson =>
  JSON.parse(read(".projen", "tasks.json")) as TasksJson;

const filesJson = (): FilesJson =>
  JSON.parse(read(".projen", "files.json")) as FilesJson;

describe("toolchain", () => {
  it("resolves TypeScript 7, not a silently-pinned 5.x", () => {
    const { devDependencies } = packageJson();
    expect(devDependencies.typescript).toBe("7.0.2");
  });

  it("resolves vitest 4.1.11 as the test runner", () => {
    const { devDependencies } = packageJson();
    expect(devDependencies.vitest).toBe("4.1.11");
  });

  it("declares a runway bin entry", () => {
    expect(packageJson().bin).toHaveProperty("runway");
  });
});

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
    const managed = filesJson().files;
    expect(managed).toContain(".oxlintrc.json");
  });
});

describe("package manager", () => {
  it("is npm — projen defaults to yarn when packageManager is unset", () => {
    expect(existsSync(join(root, "package-lock.json"))).toBe(true);
  });

  it.each(["yarn.lock", "pnpm-lock.yaml"])(
    "has no competing %s",
    (lockfile) => {
      expect(existsSync(join(root, lockfile))).toBe(false);
    },
  );
});
