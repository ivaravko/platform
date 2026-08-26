import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditProductionPolicy, type IamPolicy } from "../src";

/**
 * E2 / EP-06: the audit that refuses and never repairs.
 *
 * A read-only pass over an existing project's IAM policy, run before adoption.
 * It reports every binding that would leave EP-01 unenforced, and it changes
 * nothing — remediation belongs to the team that knows why the binding exists.
 */

/** A policy that should adopt cleanly: the CI deployer, and read-only humans. */
const cleanPolicy = (): IamPolicy => ({
  bindings: [
    {
      role: "roles/run.admin",
      members: ["serviceAccount:ci-deployer@acme-prd.iam.gserviceaccount.com"],
    },
    { role: "roles/run.viewer", members: ["group:developers@acme.com"] },
    { role: "roles/logging.viewer", members: ["user:dana@acme.com"] },
  ],
});

describe("EP-06: refuse a production project that already grants human deploys", () => {
  it("flags a user binding holding a deploy-capable role", () => {
    const result = auditProductionPolicy({
      projectId: "acme-prd",
      policy: {
        bindings: [{ role: "roles/run.admin", members: ["user:dana@acme.com"] }],
      },
    });

    expect(result.compliant).toBe(false);
    if (result.compliant) throw new Error("unreachable");
    expect(result.offending).toEqual([
      {
        principal: "user:dana@acme.com",
        role: "roles/run.admin",
        verbs: ["run.services.create", "run.services.update", "run.services.setIamPolicy"],
      },
    ]);
  });

  it("flags a group binding — a group is people", () => {
    const result = auditProductionPolicy({
      projectId: "acme-prd",
      policy: {
        bindings: [{ role: "roles/editor", members: ["group:platform-team@acme.com"] }],
      },
    });

    expect(result.compliant).toBe(false);
  });

  it("does not flag the service account expected to hold the deploy role", () => {
    const result = auditProductionPolicy({
      projectId: "acme-prd",
      policy: {
        bindings: [
          {
            role: "roles/run.admin",
            members: ["serviceAccount:ci-deployer@acme-prd.iam.gserviceaccount.com"],
          },
        ],
      },
    });

    expect(result.compliant).toBe(true);
  });

  it("does not flag a group declared as the CI identity", () => {
    const result = auditProductionPolicy({
      projectId: "acme-prd",
      policy: {
        bindings: [{ role: "roles/run.admin", members: ["group:ci@acme.com"] }],
      },
      ciIdentities: ["group:ci@acme.com"],
    });

    expect(result.compliant).toBe(true);
  });

  it("flags a custom deploy-capable role, however it is named", () => {
    const result = auditProductionPolicy({
      projectId: "acme-prd",
      policy: {
        bindings: [
          {
            role: "projects/acme-prd/roles/costReporting",
            members: ["user:dana@acme.com"],
          },
        ],
      },
      customRolePermissions: {
        "projects/acme-prd/roles/costReporting": [
          "bigquery.jobs.create",
          "run.services.update",
        ],
      },
    });

    expect(result.compliant).toBe(false);
  });

  it("refuses to pass a human's custom role whose permissions were not resolved", () => {
    // Undecidable must not collapse to "clean" — that is the silently
    // permissive direction, and it is how EP-06 would report success while
    // being false.
    expect(() =>
      auditProductionPolicy({
        projectId: "acme-prd",
        policy: {
          bindings: [
            { role: "projects/acme-prd/roles/mystery", members: ["user:dana@acme.com"] },
          ],
        },
      }),
    ).toThrow(/resolve/i);
  });

  it("ignores an unresolved custom role held only by service accounts", () => {
    // The CI deployer may hold a custom role this audit has never heard of.
    // No human holds it, so nothing about EP-06 turns on what it grants.
    const result = auditProductionPolicy({
      projectId: "acme-prd",
      policy: {
        bindings: [
          {
            role: "projects/acme-prd/roles/deployerExtras",
            members: ["serviceAccount:ci-deployer@acme-prd.iam.gserviceaccount.com"],
          },
        ],
      },
    });

    expect(result.compliant).toBe(true);
  });

  it("passes a clean policy", () => {
    expect(auditProductionPolicy({ projectId: "acme-prd", policy: cleanPolicy() })).toEqual({
      compliant: true,
    });
  });

  it("fires when one human binding is added to the same clean policy", () => {
    // Failure-injected: the absence proven against injected presence. The
    // clean fixture passing alone would also pass if the audit checked
    // nothing at all.
    const clean = cleanPolicy();
    const poisoned: IamPolicy = {
      bindings: [
        ...clean.bindings,
        { role: "roles/run.developer", members: ["user:mallory@acme.com"] },
      ],
    };

    expect(auditProductionPolicy({ projectId: "acme-prd", policy: clean }).compliant).toBe(true);
    const result = auditProductionPolicy({ projectId: "acme-prd", policy: poisoned });
    expect(result.compliant).toBe(false);
    if (result.compliant) throw new Error("unreachable");
    expect(result.offending).toEqual([
      {
        principal: "user:mallory@acme.com",
        role: "roles/run.developer",
        verbs: ["run.services.create", "run.services.update"],
      },
    ]);
  });
});

/** Two offending bindings, for asserting the refusal text names them all. */
const refusedAudit = () =>
  auditProductionPolicy({
    projectId: "acme-checkout-prd",
    policy: {
      bindings: [
        { role: "roles/run.admin", members: ["user:dana@acme.com"] },
        { role: "roles/editor", members: ["group:platform-team@acme.com"] },
      ],
    },
  });

describe("EP-06: the refusal carries the whole decision", () => {

  it("names the project and every offending binding", () => {
    const audit = refusedAudit();
    if (audit.compliant) throw new Error("expected a refusal");

    expect(audit.refusal).toContain("acme-checkout-prd");
    expect(audit.refusal).toContain("user:dana@acme.com");
    expect(audit.refusal).toContain("roles/run.admin");
    expect(audit.refusal).toContain("group:platform-team@acme.com");
    expect(audit.refusal).toContain("roles/editor");
  });

  it("says what would be untrue, that nothing was changed, and what to do", () => {
    const audit = refusedAudit();
    if (audit.compliant) throw new Error("expected a refusal");

    // Matched as a phrase, not the bare id: the mapping scanner reads a
    // string literal starting with an id as "this test proves that control".
    expect(audit.refusal).toMatch(/leave EP-01 unenforced/);
    expect(audit.refusal).toContain("Nothing was changed");
    expect(audit.refusal).toMatch(/remove these bindings|different project/);
  });
});

describe("EP-06: the module cannot write IAM — asserted structurally", () => {
  const packageRoot = join(__dirname, "..");

  it("carries no runtime dependency at all", () => {
    // No GCP client, no HTTP library, nothing. A module with no way to reach
    // the IAM API cannot mutate what it audits, whatever its code says.
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  it("imports nothing outside its own source tree", () => {
    const src = join(packageRoot, "src");
    for (const file of readdirSync(src)) {
      const specifiers = [
        ...readFileSync(join(src, file), "utf-8").matchAll(/from "([^"]+)"/g),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^\.\//);
      }
    }
  });

  it("does not mutate the policy it audits", () => {
    // Frozen input: any write throws in strict mode. The audit must read.
    const policy = Object.freeze({
      bindings: Object.freeze([
        Object.freeze({
          role: "roles/run.admin",
          members: Object.freeze(["user:dana@acme.com"]),
        }),
      ]),
    });

    expect(() => auditProductionPolicy({ projectId: "acme-prd", policy })).not.toThrow();
  });
});
