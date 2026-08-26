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
  readonly if?: string;
  readonly permissions?: Record<string, string>;
  readonly steps?: { uses?: string; run?: string; name?: string; if?: string }[];
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
  it("emits exactly the build, integration and security workflows", () => {
    expect(readdirSync(workflowDir).toSorted()).toEqual([
      "build.yml",
      "integration.yml",
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

describe("platform CI: integration (T12)", () => {
  it("never runs on a pull request — the PR gate stays credential-free and offline", () => {
    // The isolation is the trigger set itself: nightly and on demand, and
    // nothing else. A pull_request trigger here would be a PR deploying to
    // GCP, which is the failure the tier's whole structure exists to prevent.
    const on = workflow("integration").on;
    expect(Object.keys(on).toSorted()).toEqual(["schedule", "workflow_dispatch"]);
  });

  it("is inert until federation for this repository exists", () => {
    // The same forward contract as the scaffold's package job: skipped, not
    // red, until the repository variables are set. A nightly that cannot
    // authenticate would be red forever, and a muted tier reads as a green one.
    expect(workflow("integration").jobs.integration.if).toContain(
      "vars.RUNWAY_PLATFORM_WIF_PROVIDER",
    );
  });

  it("authenticates by federation: an identity token, no stored secret", () => {
    const job = workflow("integration").jobs.integration;
    expect(job.permissions?.["id-token"]).toBe("write");
    expect(stepsOf(job)).toContain("google-github-actions/auth");

    const source = readFileSync(join(workflowDir, "integration.yml"), "utf-8");
    expect(source).not.toMatch(/secrets\./);
  });

  it("names the sandbox through a variable and the guard, never a literal id", () => {
    // assertSandbox() rejects anything but the one designated project, so the
    // variable cannot point the tier somewhere else — and the workflow file
    // carries no project id, per the no-baked-identifiers rule.
    const source = readFileSync(join(workflowDir, "integration.yml"), "utf-8");
    expect(source).toContain("RUNWAY_SANDBOX_PROJECT");
    expect(source).not.toContain("enduring-badge");
  });

  it("runs the gated tier, and verifies emptiness even after a failed run", () => {
    const job = workflow("integration").jobs.integration;
    expect(stepsOf(job)).toContain("npm run test:integration");

    // `test:integration` already ends with the verify task, but a mid-tier
    // crash never reaches it — and an unverified sandbox after a failed run
    // is exactly when a leak is likeliest.
    const verify = (job.steps ?? []).find((s) =>
      (s.run ?? "").includes("test:integration:verify"),
    );
    expect(verify?.if).toBe("always()");
  });
});

describe("platform CI: no baked credentials", () => {
  it.each(["build", "integration", "security"])(
    "%s.yml contains no literal secret",
    (name) => {
      const source = readFileSync(join(workflowDir, `${name}.yml`), "utf-8");

      expect(source).not.toMatch(/AIza|-----BEGIN|ghp_|github_pat_|projects\/\d+/);
    },
  );
});
