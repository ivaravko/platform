import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Per-package toolchain pins for @runway/cli.
 *
 * The linter, lint config, and package-manager assertions that used to live
 * here moved to the workspace root in C1 — they describe the repo, not this
 * package. What remains is what this package independently declares.
 */

const root = join(__dirname, "..");

interface PackageJson {
  readonly devDependencies: Record<string, string>;
  readonly bin?: Record<string, string>;
}

const packageJson = (): PackageJson =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as PackageJson;

describe("toolchain", () => {
  it("resolves TypeScript 7, not a silently-pinned 5.x", () => {
    expect(packageJson().devDependencies.typescript).toBe("7.0.2");
  });

  it("resolves vitest 4.1.11 as the test runner", () => {
    expect(packageJson().devDependencies.vitest).toBe("4.1.11");
  });

  it("declares a runway bin entry", () => {
    expect(packageJson().bin).toHaveProperty("runway");
  });
});
