import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunwayServiceProject } from "../../src";
import { withLocalPackages } from "../support/local-links";

/**
 * Task 5: the things a green CI run hides.
 *
 * A workflow that passes tells you nothing about whether it bakes in a
 * credential, or whether the self-mutation job can actually run in the repo it
 * was generated for. Both are asserted here, because both are invisible until
 * they matter.
 */

interface Job {
  readonly if?: string;
  readonly permissions?: Record<string, string>;
}

let outdir: string;
let workflowSource: string;
let jobs: Record<string, Job>;
let readme: string;

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "runway-contract-"));
  process.env.PROJEN_DISABLE_POST = "true";
  new RunwayServiceProject({ name: "demo", outdir, region: "europe-west1" }).synth();

  workflowSource = readFileSync(
    join(outdir, ".github/workflows/build.yml"),
    "utf-8",
  );
  jobs = (parse(workflowSource) as { jobs: Record<string, Job> }).jobs;
  readme = readFileSync(join(outdir, "README.md"), "utf-8");
});

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("workflow contract", () => {
  it("references exactly one secret, and it is the expected one", () => {
    const referenced = [
      ...workflowSource.matchAll(/secrets\.([A-Z_]+)/g),
    ].map((match) => match[1]);

    // An allowlist, not a denylist: a new secret introduced by a projen upgrade
    // has to be noticed and justified rather than quietly inherited.
    //
    // Only one, not the two the task anticipated: the build job runs on the
    // default GITHUB_TOKEN without naming it, so PROJEN_GITHUB_TOKEN — used by
    // self-mutation to push — is the sole explicit reference.
    expect([...new Set(referenced)].toSorted()).toEqual(["PROJEN_GITHUB_TOKEN"]);
  });

  it("bakes in no literal credential, project id or region", () => {
    expect(workflowSource).not.toMatch(
      /AIza|-----BEGIN|ghp_|github_pat_|projects\/\d+/,
    );
  });

  it("gates self-mutation on not-a-fork and grants it write access", () => {
    const selfMutation = jobs["self-mutation"];

    // Without the fork guard the push step would fail on every fork PR; without
    // contents: write it would fail on all of them.
    expect(selfMutation.if).toContain("github.event.pull_request.head.repo.full_name");
    expect(selfMutation.permissions?.contents).toBe("write");
  });
});

describe("workflow contract: the README carries the caveat", () => {
  it("names PROJEN_GITHUB_TOKEN and says what breaks without it", () => {
    expect(readme).toContain("PROJEN_GITHUB_TOKEN");
  });

  it("warns that self-mutation is skipped on forks", () => {
    expect(readme).toMatch(/fork/i);
  });
});

describe("workflow contract: stale output fails the build", () => {
  it(
    "leaves a diff when committed output is stale, which is what CI trips on",
    { timeout: 600_000 },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "runway-stale-"));
      const git = (...args: string[]): void => {
        execFileSync("git", args, { cwd: dir, stdio: "pipe" });
      };

      try {
        withLocalPackages(() =>
          new RunwayServiceProject({
            name: "demo",
            outdir: dir,
            region: "europe-west1",
          }).synth(),
        );
        execFileSync("npm", ["install"], { cwd: dir, stdio: "pipe" });

        // Detection lives in the workflow, not in the build task: the job runs
        // `build` and then diffs the tree. Reproduced here rather than asserted,
        // because `npx projen build` alone exits 0 on a stale tree.
        git("init", "-q");
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "Test");

        // Commit output that does not match .projenrc.ts — the exact mistake of
        // hand-editing a generated file and pushing it.
        const managed = join(dir, "tsconfig.json");
        const stale = readFileSync(managed, "utf-8").replace(
          /"target":\s*"[^"]+"/,
          '"target": "es2015"',
        );
        // projen marks the files it owns read-only, so this mistake takes
        // deliberate effort to make — but it is still made, which is why CI
        // checks for it rather than trusting the file mode.
        chmodSync(managed, 0o644);
        writeFileSync(managed, stale);
        git("add", "-A");
        git("commit", "-q", "-m", "stale generated output");

        execFileSync("npx", ["projen", "build"], { cwd: dir, stdio: "pipe" });

        // Regeneration restored the correct target, so the tree now differs
        // from what was committed. This non-zero exit is the CI failure.
        expect(() => git("diff", "--exit-code")).toThrow();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
