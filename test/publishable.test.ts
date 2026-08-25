import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * E9: what has to be true before a package is published.
 *
 * Inside this monorepo every package resolves its imports from the hoisted root
 * `node_modules`, so a missing dependency declaration is invisible — the import
 * works, the build passes, the tests pass. It only fails once someone installs
 * the published tarball on its own, which is exactly the moment nobody is
 * watching. `@runway/cli` imported `projen` and declared it nowhere; that is the
 * bug this file exists to have caught.
 *
 * A published version is also permanent. Artifact Registry will not accept
 * different bytes under a number it already holds, so a package that ships
 * wrong ships wrong forever under that version.
 */

const root = join(__dirname, "..");
const PACKAGES = readdirSync(join(root, "packages"));

interface PackageJson {
  readonly name: string;
  readonly private?: boolean;
  readonly version?: string;
  readonly publishConfig?: { readonly registry?: string };
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

const readPackage = (pkg: string): PackageJson =>
  JSON.parse(
    readFileSync(join(root, "packages", pkg, "package.json"), "utf-8"),
  ) as PackageJson;

/** Every .ts file under a directory, recursively. */
const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });

/**
 * The bare module specifiers a package imports at runtime, as package names.
 *
 * Relative imports resolve within the tarball and node: builtins need no
 * declaration, so both are dropped. A subpath import (`@pulumi/policy/policy`)
 * is attributed to the package that must be installed for it to resolve.
 *
 * **Template literals are stripped first, and imports must start at column 0.**
 * runway-cli's whole job is emitting source code, so its files are full of
 * `import ... from "vite"` lines that are strings rather than imports — scanning
 * naively attributes the scaffold's dependencies to the scaffolder. Real imports
 * are unindented and top-level; the generated code lives inside backticks.
 */
const importedPackages = (pkg: string): string[] => {
  const specifiers = sourceFiles(join(root, "packages", pkg, "src")).flatMap(
    (file) => {
      const code = readFileSync(file, "utf-8").replace(
        /`(?:\\.|[^`\\])*`/gs,
        "``",
      );
      return [
        ...code.matchAll(/^import\s[^;]*?from\s*"([^"]+)"/gm),
        ...code.matchAll(/^import\s*"([^"]+)"/gm),
      ]
        .map((m) => m[1] ?? "")
        .filter((s) => !s.startsWith(".") && !s.startsWith("node:"));
    },
  );

  const names = specifiers.map((specifier) => {
    const parts = specifier.split("/");
    return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
  });
  return [...new Set(names)].toSorted();
};

describe.each(PACKAGES)("packages/%s", (pkg) => {
  it("declares every package its source imports at runtime", () => {
    // devDependencies deliberately do not count: they are not installed for a
    // consumer, so a runtime import satisfied only by one is still broken.
    const manifest = readPackage(pkg);
    const declared = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);

    const undeclared = importedPackages(pkg).filter((name) => !declared.has(name));
    expect(undeclared, `undeclared runtime imports in ${manifest.name}`).toEqual([]);
  });

  it("carries a version and the Artifact Registry it publishes to", () => {
    const manifest = readPackage(pkg);
    // 0.0.0 is projen's placeholder for a package with releases disabled.
    // Publishing it would burn the number every generated repo then pins.
    expect(manifest.version, manifest.name).not.toBe("0.0.0");
    expect(manifest.publishConfig?.registry, manifest.name).toContain(
      "npm.pkg.dev",
    );
  });

  it("is not private, or it could never publish at all", () => {
    expect(readPackage(pkg).private ?? false).toBe(false);
  });
});
