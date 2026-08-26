import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunwayServiceProject } from "../../src";

/**
 * The release workflow: SPEC-release-path.md's generation and static tiers.
 *
 * Production deploys only from here — a tag push or a dispatch on a tag ref —
 * and only as a digest. Every assertion below maps to an RP control, and the
 * ones asserting absence (no secret, no tag deploy) exist because absence is
 * what this codebase has repeatedly failed to test.
 */

interface Step {
  readonly if?: string;
  readonly name?: string;
  readonly run?: string;
  readonly uses?: string;
}

interface Workflow {
  readonly on: {
    readonly push?: { readonly tags?: string[]; readonly branches?: string[] };
    readonly workflow_dispatch?: unknown;
  };
  readonly jobs: Record<
    string,
    {
      readonly if?: string;
      readonly env?: Record<string, string>;
      readonly permissions?: Record<string, string>;
      readonly steps: Step[];
    }
  >;
}

let outdir: string;
let source: string;
let workflow: Workflow;
let steps: Step[];

beforeAll(() => {
  outdir = mkdtempSync(join(tmpdir(), "runway-release-"));
  process.env.PROJEN_DISABLE_POST = "true";
  new RunwayServiceProject({ name: "demo", outdir, region: "europe-west1" }).synth();

  source = readFileSync(join(outdir, ".github/workflows/release.yml"), "utf-8");
  workflow = parse(source) as Workflow;
  steps = workflow.jobs.release.steps;
});

afterAll(() => {
  rmSync(outdir, { recursive: true, force: true });
});

/** Index of the first step whose run script contains the needle. */
const stepIndex = (needle: string): number =>
  steps.findIndex((step) => (step.run ?? "").includes(needle));

describe("release workflow: triggers", () => {
  it("runs on version tags and on dispatch, and on nothing else", () => {
    // Tag push is the release interface; dispatch on a tag ref is the
    // rollback (RP-06). A branch trigger here would be a second route to
    // production, which is exactly what this module exists to prevent.
    expect(workflow.on.push?.tags).toEqual(["v*"]);
    expect(workflow.on.push?.branches).toBeUndefined();
    expect("workflow_dispatch" in workflow.on).toBe(true);
    expect(Object.keys(workflow.on).toSorted()).toEqual(["push", "workflow_dispatch"]);
  });

  it("refuses a non-tag ref as its first step (RP-06)", () => {
    // A dispatch on main must die here, before any credential is minted.
    // Federation refuses it too — this guard is the readable half.
    const guard = steps[0];
    expect(guard.if).toContain("github.ref_type != 'tag'");
    expect(guard.run).toContain("exit 1");
  });

  it("fails loudly when the bootstrap variables are missing, never skips", () => {
    // A pushed tag is an explicit release request. The package job may skip
    // until bootstrap exists — a release that silently does nothing is the
    // swallowed error RP-03 warns about, so this one goes red instead.
    expect(workflow.jobs.release.if).toBeUndefined();

    const guard = steps.find((step) => (step.if ?? "").includes("vars.RUNWAY_WIF_PROVIDER"));
    expect(guard?.run).toContain("exit 1");
    expect(guard?.run).toContain("RUNWAY_PRODUCTION_STATE_BACKEND");
  });
});

describe("release workflow: identity (RP-01, RP-05)", () => {
  it("references no stored secret at all", () => {
    // The spec anticipated one secret — the one federation needs. Federation
    // as implemented needs none: an identity token is minted per run.
    expect(source).not.toMatch(/secrets\./);
  });

  it("authenticates by federation with an identity token", () => {
    expect(workflow.jobs.release.permissions?.["id-token"]).toBe("write");
    expect(workflow.jobs.release.permissions?.contents).toBe("read");
    expect(steps.some((step) => (step.uses ?? "").startsWith("google-github-actions/auth@"))).toBe(
      true,
    );
  });

  it("bakes in no literal credential", () => {
    expect(source).not.toMatch(/AIza|-----BEGIN|ghp_|github_pat_|_authToken=[^%$]/);
  });
});

describe("release workflow: promotion (RP-02, RP-03)", () => {
  it("resolves the tagged commit's staging image before any pulumi step", () => {
    // The digest comes from the image build.yml pushed for this commit —
    // resolving the git tag's own name would require something to have
    // rebuilt, and promotion is an artifact moving, not a rebuild.
    const resolve = stepIndex("sha-$GITHUB_SHA");
    const deploy = stepIndex("pulumi");

    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(deploy).toBeGreaterThanOrEqual(0);
    expect(resolve).toBeLessThan(deploy);
  });

  it("guards the resolution against an empty result (RP-03)", () => {
    // `gcloud describe` fails non-zero on a missing tag, and bash runs -e.
    // The explicit emptiness check is belt and braces, because RP-03 is the
    // control the spec names as the one that will be skipped.
    const resolve = steps[stepIndex("sha-$GITHUB_SHA")];
    expect(resolve.run).toMatch(/test -n|\[\[ -n/);
  });

  it("copies the artifact into the production registry and verifies it by digest", () => {
    // Each environment pulls from its own registry (service-stacks), so the
    // promoted digest must exist in production's before the deploy asks
    // Cloud Run to pull it. Push preserves the digest; the describe proves it.
    // The same derivation rule as everywhere else: both image paths come
    // from the service name, one per environment's own registry.
    expect(workflow.jobs.release.env).toEqual({
      STAGING_IMAGE: "europe-west1-docker.pkg.dev/demo-staging/demo/demo",
      PRODUCTION_IMAGE: "europe-west1-docker.pkg.dev/demo-production/demo/demo",
    });

    const promote = steps[stepIndex('docker push "$PRODUCTION_IMAGE')];
    expect(promote.run).toMatch(/describe "\$PRODUCTION_IMAGE@/);

    // The git tag becomes the registry name for the digest — "what shipped"
    // answerable from the production registry's tag list too.
    expect(promote.run).toContain("$GITHUB_REF_NAME");
  });

  it("deploys the digest and never writes a tag (RP-02)", () => {
    const deploy = steps[stepIndex("pulumi up")];
    expect(deploy.run).toContain("pulumi stack select production");
    expect(deploy.run).toContain("pulumi config set imageDigest");
    expect(deploy.run).not.toContain("imageTag");
  });
});

describe("release workflow: the README says how to release", () => {
  it("documents the tag push, the rollback dispatch, and the third variable", () => {
    const readme = readFileSync(join(outdir, "README.md"), "utf-8");

    expect(readme).toContain("git push origin v");
    expect(readme).toContain("gh workflow run release.yml --ref");
    expect(readme).toContain("RUNWAY_PRODUCTION_STATE_BACKEND");
  });
});
