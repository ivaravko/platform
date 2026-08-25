import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * C1: the npm workspaces layout.
 *
 * projen ships a first-class PnpmWorkspaceConfig component and no npm
 * equivalent, so the root `workspaces` array is set through the escape hatch
 * `package.addField` and **nothing in projen maintains it**. A projen upgrade
 * that changed how package.json is rendered would drop it silently, and the
 * first symptom would be workspace commands quietly resolving to nothing.
 *
 * These assertions are the alarm for that.
 */

const root = join(__dirname, "..");

interface PackageJson {
  readonly name: string;
  readonly private?: boolean;
  readonly workspaces?: string[];
  readonly bin?: Record<string, string>;
}

const readPackage = (...segments: string[]): PackageJson =>
  JSON.parse(readFileSync(join(root, ...segments, "package.json"), "utf-8")) as PackageJson;

describe("workspace root", () => {
  it("declares packages/* as its workspaces — projen does not maintain this field", () => {
    expect(readPackage().workspaces).toEqual(["packages/*"]);
  });

  it("is private, so the root is never published by accident", () => {
    expect(readPackage().private).toBe(true);
  });

  it("owns no bin entry — the CLI moved into its own package", () => {
    expect(readPackage().bin).toBeUndefined();
  });
});

describe("runway-cli package", () => {
  it("lives at packages/runway-cli and keeps its published name", () => {
    expect(readPackage("packages", "runway-cli").name).toBe("@runway/cli");
  });

  it("still declares the runway bin entry", () => {
    expect(readPackage("packages", "runway-cli").bin).toHaveProperty("runway");
  });

  it("brought its source and its per-package tests with it", () => {
    for (const f of ["src/index.ts", "test/toolchain.test.ts"]) {
      expect(existsSync(join(root, "packages", "runway-cli", f)), f).toBe(true);
    }
  });

  it("left the repo-level tests at the root, where they are now true", () => {
    // The linter, its config, and the package manager describe the workspace,
    // not the CLI. Asserting them from inside a package would either fail or
    // pass by walking out of the package it claims to be testing.
    for (const f of ["test/lint-gate.test.ts", "test/toolchain.test.ts"]) {
      expect(existsSync(join(root, f)), f).toBe(true);
    }
  });
});

describe("package manager", () => {
  it.each(["yarn.lock", "pnpm-lock.yaml"])("has no competing %s", (lockfile) => {
    expect(existsSync(join(root, lockfile))).toBe(false);
  });
});

describe("gcp-components package", () => {
  it("lives at packages/gcp-components under the runway scope", () => {
    expect(readPackage("packages", "gcp-components").name).toBe("@runway/gcp-components");
  });

  it("pins every @pulumi/* dependency exactly", () => {
    // SPEC.md: exact versions for @pulumi/*, caret ranges only for dev tooling.
    // With legacy-peer-deps disabling npm's own compatibility check, an exact
    // pin is what is left holding the verified combination in place.
    const pkg = readPackage("packages", "gcp-components") as unknown as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
    const pulumi = Object.entries(all).filter(([n]) => n.startsWith("@pulumi/"));
    expect(pulumi.length).toBeGreaterThan(0);
    for (const [name, range] of pulumi) {
      expect(range, name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it("declares @pulumi/* as peer dependencies, not plain dependencies", () => {
    // Two copies of @pulumi/pulumi in one program break resource registration.
    // A published library that bundles its own copy makes that the consumer's
    // problem, and moving deps -> peerDeps later is a breaking change.
    const pkg = readPackage("packages", "gcp-components") as unknown as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.peerDependencies ?? {})).toEqual(
      expect.arrayContaining(["@pulumi/pulumi", "@pulumi/gcp"]),
    );
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@pulumi/pulumi");
  });
});

