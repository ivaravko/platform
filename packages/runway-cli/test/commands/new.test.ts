import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError, runNew } from "../../src/commands/new";

/**
 * Unit-level cover for the `new` command.
 *
 * test/cli.test.ts already exercises all of this through the built binary,
 * which is the honest end-to-end proof — but it does so in a subprocess, so v8
 * instruments none of it. Coverage consequently reported 100% for this package
 * while three of its four source files were never measured at all. A number
 * that high is worse than a low one, because it reads as proof.
 *
 * These tests are in-process: fast, measured, and able to reach branches that
 * are awkward to provoke through a subprocess — a name past npm's length limit,
 * and a target directory that exists but is empty.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "runway-new-"));
  // Scaffolding here must not trigger a real `npm install`.
  process.env.PROJEN_DISABLE_POST = "true";
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runNew: name validation", () => {
  it.each([
    ["", "empty"],
    [".", "the current directory"],
    ["..", "the parent directory"],
    ["../escape", "a traversal"],
    ["/absolute", "an absolute path"],
    ["nested/path", "a path separator"],
    ["-leading-dash", "a leading dash"],
    ["UPPER", "an uppercase letter"],
    ["has space", "a space"],
  ])("rejects %j — %s", (name) => {
    expect(() => runNew([name], cwd)).toThrow(UsageError);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("rejects a name too long to make a valid project id", () => {
    // The name becomes <name>-production, and a GCP project id caps at 30.
    // "-production" is 11, so 19 is the ceiling. Valid characters throughout:
    // length alone must be disqualifying.
    expect(() => runNew(["a".repeat(20)], cwd)).toThrow(UsageError);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("accepts a name at exactly the limit", () => {
    expect(() => runNew(["a".repeat(19), "--region", "europe-west1"], cwd)).not.toThrow();
  });

  it("explains the project-id rule when a name is too long", () => {
    // A bare "invalid name" would send someone shortening it by guesswork.
    expect(() => runNew(["a".repeat(20)], cwd)).toThrow(/19|project id/i);
  });

  it("rejects a name starting with a digit", () => {
    // A GCP project id must start with a letter, so "2fa" yields the invalid
    // project id "2fa-staging" — caught here rather than by the GCP API later.
    expect(() => runNew(["2fa"], cwd)).toThrow(UsageError);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("requires a name at all", () => {
    expect(() => runNew([], cwd)).toThrow(/name/i);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("names the offending value, so the message is actionable", () => {
    expect(() => runNew(["Bad Name"], cwd)).toThrow(/Bad Name/);
  });
});

describe("runNew: target directory", () => {
  it("scaffolds into ./<name>", () => {
    runNew(["demo", "--region", "europe-west1"], cwd);
    expect(readdirSync(join(cwd, "demo"))).toContain(".projenrc.ts");
  });

  it("accepts a directory that exists but is empty", () => {
    // The guard is existsSync && non-empty. A guard on existence alone would
    // wrongly refuse this, and nothing else covers the distinction.
    mkdirSync(join(cwd, "demo"));

    expect(() => runNew(["demo", "--region", "europe-west1"], cwd)).not.toThrow();
    expect(readdirSync(join(cwd, "demo"))).toContain(".projenrc.ts");
  });

  it("refuses a non-empty directory without touching it", () => {
    mkdirSync(join(cwd, "demo"));
    writeFileSync(join(cwd, "demo", "keep.txt"), "precious\n");

    expect(() => runNew(["demo", "--region", "europe-west1"], cwd)).toThrow(/not empty/i);
    expect(readdirSync(join(cwd, "demo"))).toEqual(["keep.txt"]);
  });
});
