import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Task 3 exercises the shipped entry point, not the project type: `bin` points
 * at lib/cli.js, so that is what these tests run. projen's build compiles
 * before it tests, so the binary is fresh whenever this runs as part of `build`.
 *
 * The guardrails matter more than the happy path. A scaffolder that writes into
 * a directory it should have refused destroys work that is not its own, so the
 * refusal cases assert that nothing was written — not merely that it exited 1.
 */

const CLI = join(__dirname, "..", "lib", "cli.js");

let cwd: string;

const run = (
  ...args: string[]
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf-8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "runway-cli-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("runway --help", () => {
  it("documents the new command and its argument", () => {
    const { status, stdout } = run("--help");

    expect(status).toBe(0);
    expect(stdout).toContain("runway new");
    expect(stdout).toContain("<name>");
  });

  it("exits non-zero on an unknown command, naming it", () => {
    const { status, stderr } = run("teleport");

    expect(status).not.toBe(0);
    expect(stderr).toContain("teleport");
  });
});

describe("runway new", () => {
  it("scaffolds into ./<name>", () => {
    const { status } = run("new", "demo");

    expect(status).toBe(0);
    expect(readdirSync(join(cwd, "demo"))).toContain(".projenrc.ts");
  });

  it("produces a repo that builds, through the binary end to end", () => {
    expect(run("new", "demo").status).toBe(0);

    const dir = join(cwd, "demo");
    for (const [cmd, args] of [
      ["npm", ["install"]],
      ["npm", ["run", "build"]],
    ] as const) {
      execFileSync(cmd, args, { cwd: dir, stdio: "pipe" });
    }
  }, 600_000);
});

describe("guardrails", () => {
  it("refuses a non-empty directory and leaves it byte-identical", () => {
    const target = join(cwd, "demo");
    const existing = join(target, "keep.txt");
    execFileSync("mkdir", ["-p", target]);
    writeFileSync(existing, "precious\n");

    const { status, stderr } = run("new", "demo");

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/not empty/i);
    expect(readFileSync(existing, "utf-8")).toBe("precious\n");
    expect(readdirSync(target)).toEqual(["keep.txt"]);
  });

  it.each(["../escape", "../../escape", "/absolute", "nested/path"])(
    "rejects %s before writing anything",
    (name) => {
      const { status, stderr } = run("new", name);

      expect(status).not.toBe(0);
      expect(stderr).toMatch(/invalid/i);
      // The whole point: nothing was created anywhere, including outside cwd.
      expect(readdirSync(cwd)).toEqual([]);
    },
  );

  it.each(["", ".", "..", "-leading-dash", "UPPER", "has space"])(
    "rejects the invalid name %j",
    (name) => {
      const { status } = run("new", name);
      expect(status).not.toBe(0);
      expect(readdirSync(cwd)).toEqual([]);
    },
  );

  it("requires a name", () => {
    const { status, stderr } = run("new");

    expect(status).not.toBe(0);
    expect(stderr).toMatch(/name/i);
  });
});
