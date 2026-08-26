import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * E6: `runway bootstrap` — parsing and composition, end to end through the
 * shipped binary. Provisioning itself arrives with E7; what this command must
 * already do is refuse bad input before touching anything, derive every name
 * by the shared rule, and report an incomplete service visibly (EP-07).
 *
 * Every run here is executed with credential lookups pointed at nowhere: a
 * command that completed cannot have called GCP, which is what "a dry run
 * writes nothing" means before there are credentials to write with.
 */

const CLI = join(__dirname, "..", "..", "lib", "cli.js");

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "runway-bootstrap-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const run = (
  ...args: string[]
): { status: number; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [CLI, "bootstrap", ...args], {
    cwd: scratch,
    encoding: "utf-8",
    env: {
      ...process.env,
      // Any code path that consults credentials fails loudly instead of
      // quietly succeeding against a developer's real gcloud session.
      GOOGLE_APPLICATION_CREDENTIALS: join(scratch, "nonexistent.json"),
      CLOUDSDK_CONFIG: join(scratch, "no-gcloud"),
    },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const FULL = [
  "checkout",
  "--staging-project",
  "checkout-staging",
  "--production-project",
  "checkout-production",
  "--github-repo",
  "acme/checkout",
  "--region",
  "europe-west1",
];

describe("runway bootstrap: refusals come before anything else", () => {
  it("requires a service name", () => {
    const result = run("--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/service <name> is required/);
  });

  it("requires --staging-project, and says so by name", () => {
    const result = run("checkout", "--region", "europe-west1", "--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--staging-project");
  });

  it("refuses a staging project that breaks the derivation rule", () => {
    // Project ids derive from the service name — the same rule the scaffold
    // and ServiceEnvironment compute with. The flag is confirmation, not
    // configuration, and a mismatch is a typo about to become someone's IAM.
    const result = run(
      "checkout",
      "--staging-project",
      "acme-stg",
      "--region",
      "europe-west1",
      "--dry-run",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checkout-staging");
  });

  it("refuses a production project that breaks the derivation rule", () => {
    const result = run(
      "checkout",
      "--staging-project",
      "checkout-staging",
      "--production-project",
      "prod",
      "--github-repo",
      "acme/checkout",
      "--region",
      "europe-west1",
      "--dry-run",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("checkout-production");
  });

  it("refuses an invalid repository spec", () => {
    const result = run(
      "checkout",
      "--staging-project",
      "checkout-staging",
      "--production-project",
      "checkout-production",
      "--github-repo",
      "not-a-repo",
      "--region",
      "europe-west1",
      "--dry-run",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/org\/repo|repository/);
  });

  it("requires --github-repo when production is requested", () => {
    const result = run(
      "checkout",
      "--staging-project",
      "checkout-staging",
      "--production-project",
      "checkout-production",
      "--region",
      "europe-west1",
      "--dry-run",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--github-repo");
  });

  it("refuses to provision without a bootstrap state backend, naming it", () => {
    // The wet path needs somewhere for the bootstrap stack's own state; a
    // bare run gets the requirement, not a silent no-op or a guessed backend.
    const result = run(...FULL);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--bootstrap-state");
  });

  it("refuses an individual passed as the developers group", () => {
    const result = run(...FULL, "--developers-group", "user:dana@acme.com", "--dry-run");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/EP-04/);
  });
});

describe("runway bootstrap --dry-run: the plan, and nothing else", () => {
  it("staging only: derives the names and reports the service incomplete (EP-07)", () => {
    const result = run(
      "checkout",
      "--staging-project",
      "checkout-staging",
      "--region",
      "europe-west1",
      "--dry-run",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("checkout-staging");
    expect(result.stdout).toContain("checkout-staging-state");
    // Visibly, not by omission: the report names what is not enforced.
    expect(result.stdout).toContain("INCOMPLETE");
    expect(result.stdout).toMatch(/EP-01.*EP-02.*EP-03.*EP-06/s);
    expect(result.stdout).toContain("Nothing was changed");
  });

  it("both environments: plans production and drops the incomplete report", () => {
    // The failure-injected other half: the report tracks the absence.
    const result = run(...FULL, "--dry-run");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("checkout-production");
    expect(result.stdout).toContain("checkout-production-state");
    expect(result.stdout).toContain("checkout-github");
    expect(result.stdout).toContain(
      "checkout-deployer@checkout-production.iam.gserviceaccount.com",
    );
    expect(result.stdout).not.toContain("INCOMPLETE");
    expect(result.stdout).toContain("Nothing was changed");
  });
});

describe("runway bootstrap --print-config: the contract the repo consumes", () => {
  it("emits the three repository variables and the backends", () => {
    const result = run(...FULL, "--print-config");

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("RUNWAY_WIF_PROVIDER");
    expect(result.stdout).toContain("RUNWAY_CI_SERVICE_ACCOUNT=");
    expect(result.stdout).toContain(
      "checkout-deployer@checkout-production.iam.gserviceaccount.com",
    );
    expect(result.stdout).toContain(
      "RUNWAY_PRODUCTION_STATE_BACKEND=gs://checkout-production-state",
    );
    expect(result.stdout).not.toContain("INCOMPLETE");
  });

  it("reports a staging-only service incomplete here too (EP-07)", () => {
    const result = run(
      "checkout",
      "--staging-project",
      "checkout-staging",
      "--print-config",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("INCOMPLETE");
    expect(result.stdout).toMatch(/EP-01.*EP-02.*EP-03.*EP-06/s);
  });
});

describe("runway --help", () => {
  it("lists bootstrap, its flags, and which are required", () => {
    const result = spawnSync(process.execPath, [CLI, "--help"], {
      encoding: "utf-8",
    });
    expect(result.stdout).toContain("bootstrap");
    expect(result.stdout).toContain("--staging-project");
    expect(result.stdout).toMatch(/--production-project.*optional/i);
  });
});
