import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

/**
 * The platform's own CI.
 *
 * SPEC-runway-cli's scaffold gets its workflow asserted rather than reviewed,
 * and the platform should be held to what it imposes on the repos it generates.
 * These checks are about *shape*: that the gates exist, that they run on the
 * events that matter, and that no credential is baked into a workflow file.
 */

const root = join(__dirname, "..");
const workflowDir = join(root, ".github", "workflows");

interface Job {
  readonly permissions?: Record<string, string>;
  readonly steps?: { uses?: string; run?: string; name?: string }[];
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, Job>;
}

const workflow = (name: string): Workflow =>
  parse(readFileSync(join(workflowDir, `${name}.yml`), "utf-8")) as Workflow;

const stepsOf = (job: Job): string =>
  (job.steps ?? []).map((s) => `${s.uses ?? ""} ${s.run ?? ""}`).join("\n");

describe("platform CI: workflows present", () => {
  it("emits exactly the build and security workflows", () => {
    expect(readdirSync(workflowDir).toSorted()).toEqual([
      "build.yml",
      "security.yml",
    ]);
  });
});

describe("platform CI: build", () => {
  it("runs on pull requests, pushes to main, and on demand", () => {
    const on = workflow("build").on;

    expect(Object.keys(on).toSorted()).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    expect(on.push).toEqual({ branches: ["main"] });
  });

  it("runs the build task, which chains test, typecheck and lint", () => {
    expect(stepsOf(workflow("build").jobs.build)).toContain("projen build");
  });

  it("installs with a frozen lockfile, so CI cannot rewrite it", () => {
    // Node 22.18 bundles npm 10, which strips the `libc` fields npm 11 writes.
    // A mutable install rewrote package-lock.json on every run and the mutation
    // check failed the build — which is exactly how this was found. `npm ci`
    // never writes the lockfile.
    const steps = stepsOf(workflow("build").jobs.build);
    expect(steps).toContain("npm ci");
    expect(steps).not.toMatch(/^npm install$/m);
  });

  it("keeps self-mutation, as the generated repos do", () => {
    expect(Object.keys(workflow("build").jobs)).toContain("self-mutation");
  });
});

describe("platform CI: security", () => {
  it("audits dependencies", () => {
    // legacy-peer-deps disables npm's own compatibility checking repo-wide.
    // Auditing is part of what compensates for that accepted cost.
    expect(stepsOf(workflow("security").jobs.audit)).toContain("npm audit");
  });

  it("scans for committed credentials", () => {
    // SPEC.md: "Never commit service account keys, .pulumi/ state, or any
    // credential." Until now nothing enforced it.
    expect(stepsOf(workflow("security").jobs.secrets)).toContain("gitleaks");
  });

  it("runs CodeQL over our own TypeScript, with the permission it needs", () => {
    const codeql = workflow("security").jobs.codeql;

    expect(stepsOf(codeql)).toContain("codeql-action/init");
    expect(stepsOf(codeql)).toContain("codeql-action/analyze");
    expect(codeql.permissions?.["security-events"]).toBe("write");
  });

  it("runs on pull requests and pushes to main", () => {
    const on = workflow("security").on;

    expect(Object.keys(on)).toContain("pull_request");
    expect(on.push).toEqual({ branches: ["main"] });
  });
});

describe("platform CI: no baked credentials", () => {
  it.each(["build", "security"])("%s.yml contains no literal secret", (name) => {
    const source = readFileSync(join(workflowDir, `${name}.yml`), "utf-8");

    expect(source).not.toMatch(/AIza|-----BEGIN|ghp_|github_pat_|projects\/\d+/);
  });
});
