import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunwayServiceProject } from "../../src";

/**
 * Task 4: the scaffold emits one CI workflow and nothing else.
 *
 * projen's TypeScriptProject would otherwise add a release workflow, a
 * dependency-upgrade workflow, a PR linter, a mergify config and a PR template.
 * Every one is noise against the module's minimality constraint, so "exactly
 * one file under .github/" is asserted rather than reviewed — it fails loudly
 * when a projen upgrade introduces a new default.
 *
 * The workflow is parsed rather than string-matched, so a malformed file fails
 * here instead of on the user's first pull request.
 */

interface Step {
  readonly uses?: string;
  readonly run?: string;
  readonly name?: string;
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly jobs: Record<string, { readonly steps?: Step[] }>;
}

let outdir: string;
let workflow: Workflow;

const describeStep = (step: Step): string => step.uses ?? step.run ?? "";

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "runway-ci-"));
  process.env.PROJEN_DISABLE_POST = "true";
  new RunwayServiceProject({ name: "demo", outdir }).synth();
  workflow = parse(
    readFileSync(join(outdir, ".github/workflows/build.yml"), "utf-8"),
  ) as Workflow;
});

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

describe("ci workflow", () => {
  it("emits exactly one file under .github/workflows", () => {
    expect(readdirSync(join(outdir, ".github/workflows"))).toEqual([
      "build.yml",
    ]);
  });

  it("adds no release, upgrade, PR-lint, mergify or PR-template files", () => {
    const dotGithub = readdirSync(join(outdir, ".github"));
    expect(dotGithub).toEqual(["workflows"]);
    expect(readdirSync(outdir)).not.toContain(".mergify.yml");
  });

  it("runs on pull requests, pushes to main, and on demand", () => {
    expect(Object.keys(workflow.on).toSorted()).toEqual([
      "pull_request",
      "push",
      "workflow_dispatch",
    ]);
    expect(workflow.on.push).toEqual({ branches: ["main"] });
  });

  it("builds in order: checkout, node, install, projen build", () => {
    const steps = (workflow.jobs.build.steps ?? []).map(describeStep);

    expect(steps[0]).toContain("actions/checkout");
    expect(steps[1]).toContain("actions/setup-node");
    expect(steps[2]).toContain("npm");
    expect(steps[3]).toContain("projen build");
  });

  it("detects stale projen output rather than ignoring it", () => {
    // The build job carries three more steps past the build itself, because
    // mutableBuild is left on: they diff the tree, upload the patch, and fail
    // the run if `projen build` changed anything. That is the mechanism the
    // self-mutation job then repairs — see Task 5.
    const steps = (workflow.jobs.build.steps ?? []).map(describeStep).join("\n");

    expect(steps).toContain("git diff --staged");
    expect(Object.keys(workflow.jobs)).toContain("self-mutation");
  });

  it("uses no package-manager setup action — npm needs none", () => {
    const steps = (workflow.jobs.build.steps ?? []).map(describeStep).join(" ");
    expect(steps).not.toContain("pnpm/action-setup");
    expect(steps).not.toContain("oven-sh/setup-bun");
  });

  it("pins the workflow node version to minNodeVersion and caches npm", () => {
    const setupNode = (workflow.jobs.build.steps ?? []).find((s) =>
      s.uses?.includes("actions/setup-node"),
    ) as { with?: Record<string, unknown> } | undefined;

    expect(setupNode?.with?.["node-version"]).toBe("22.18.0");
    expect(setupNode?.with?.cache).toBe("npm");
  });
});
