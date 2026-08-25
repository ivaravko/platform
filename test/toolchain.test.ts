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

const packageJson = (): Record<string, any> =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));

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
