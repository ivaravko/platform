import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Task 1b: prove the lint gate actually gates.
 *
 * test/toolchain.test.ts asserts the lint *task* is wired with the right flags.
 * That is a check on configuration, and configuration can be correct while the
 * tool does nothing — `--deny-warnings` on a rule set that never fires is still
 * a green build. These tests run oxlint against deliberately bad fixtures and
 * assert on its exit code, which is the only thing CI actually reads.
 *
 * Fixtures live inside the repo rather than in os.tmpdir() on purpose: oxlint
 * resolves .oxlintrc.json and tsconfig.json from the working directory, and
 * type-aware rules silently degrade without them. A fixture outside the repo
 * would pass for the wrong reason.
 */

const root = join(__dirname, "..");
const fixtureDir = join(root, ".tmp-scaffold", "lint-gate");

const OXLINT = join(root, "node_modules", ".bin", "oxlint");

/** Writes a fixture and returns oxlint's exit code for it. */
const lintFixture = (
  filename: string,
  source: string,
  flags: readonly string[],
  dir: string = fixtureDir,
): number => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, filename);
  writeFileSync(file, source, "utf-8");

  const result = spawnSync(OXLINT, [...flags, file], {
    cwd: root,
    encoding: "utf-8",
  });

  // A null status means the process was killed by a signal — not a lint verdict.
  expect(result.status).not.toBeNull();
  return result.status ?? -1;
};

const CLEAN = `export function add(a: number, b: number): number {
  return a + b;
}
`;

const UNUSED_VARIABLE = `export function add(a: number, b: number): number {
  const neverUsed = 42;
  return a + b;
}
`;

// no-floating-promises cannot be decided from syntax alone: knowing that work()
// returns a Promise requires type information.
const FLOATING_PROMISE = `async function work(): Promise<void> {}

export function go(): void {
  work();
}
`;

const workspaceFixtureDir = join(root, "packages", "runway-cli", ".tmp-scaffold", "lint-gate");

afterAll(() => {
  rmSync(join(root, ".tmp-scaffold"), { recursive: true, force: true });
  rmSync(join(root, "packages", "runway-cli", ".tmp-scaffold"), {
    recursive: true,
    force: true,
  });
});

describe("lint gate", () => {
  it("accepts clean code, so a non-zero exit means something real", () => {
    expect(lintFixture("clean.ts", CLEAN, ["--type-aware", "--deny-warnings"]))
      .toBe(0);
  });

  it("rejects an unused variable", () => {
    expect(
      lintFixture("unused.ts", UNUSED_VARIABLE, [
        "--type-aware",
        "--deny-warnings",
      ]),
    ).not.toBe(0);
  });

  it("rejects a floating promise", () => {
    expect(
      lintFixture("floating.ts", FLOATING_PROMISE, [
        "--type-aware",
        "--deny-warnings",
      ]),
    ).not.toBe(0);
  });

  it("misses the floating promise without --type-aware, proving the flag is load-bearing", () => {
    // The discriminating check. If this ever starts failing, --type-aware has
    // stopped being what catches type-dependent defects, and the lint task's
    // flag is no longer earning its cost.
    expect(lintFixture("floating.ts", FLOATING_PROMISE, ["--deny-warnings"]))
      .toBe(0);
  });
});

describe("workspace coverage", () => {
  // C1 claims one oxlint pass from the root covers every package. Nothing else
  // proves it: the root suite and each package's suite would both stay green if
  // root linting silently stopped descending into packages/.
  it("catches a violation inside packages/ from a single root invocation", () => {
    expect(
      lintFixture(
        "in-package.ts",
        UNUSED_VARIABLE,
        ["--type-aware", "--deny-warnings"],
        workspaceFixtureDir,
      ),
    ).not.toBe(0);
  });

  it("applies the root .oxlintrc.json inside packages/ — oxlint walks up to find it", () => {
    // no-explicit-any is enabled only by the root config, so catching it here
    // proves config discovery crosses the package boundary. Without it, each
    // package would silently lint against oxlint's defaults instead of ours.
    const source = "export const identity = (x: any): any => x;\n";
    expect(
      lintFixture("any.ts", source, ["--deny-warnings"], workspaceFixtureDir),
    ).not.toBe(0);
  });
});
