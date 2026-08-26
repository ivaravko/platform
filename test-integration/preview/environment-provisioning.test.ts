import { describe, expect, it } from "vitest";
import { auditProductionPolicy } from "@runway/environment-provisioning";
import {
  getCustomRolePermissions,
  getProjectIamPolicy,
} from "../support/gcp-client";
import { SANDBOX_PROJECT_ID } from "../support/sandbox";
import { type PlannedResource, collectPlanned, withFixtureStack } from "../support/stack";

/**
 * E7, as plan OQ1/OQ2 resolved it: **preview-only, refusal-only.**
 *
 * The tier reads the sandbox's live IAM policy and previews the staging
 * bootstrap program. It writes nothing and grants nothing. What that buys:
 * EP-06's refusal demonstrated against a real project's real policy, and the
 * staging composition accepted by the real provider. What it deliberately
 * does not buy — recorded in SPEC-environment-provisioning.md's verification
 * status — is the acceptance path and the observed 403 that is this module's
 * central claim.
 */

const PREVIEW_TIMEOUT_MS = 300_000;

describe("EP-06 against a real project", () => {
  it(
    "refuses the sandbox, whose owner is a human, naming the binding",
    { timeout: 120_000 },
    async () => {
      const policy = await getProjectIamPolicy();
      const bindings = (policy.bindings ?? []).map((b) => ({
        role: b.role ?? "",
        members: b.members ?? [],
      }));
      expect(bindings.length).toBeGreaterThan(0);

      // The audit refuses to guess about custom roles humans hold, so the
      // tier resolves each one from its live definition first — exactly what
      // a real bootstrap run will do.
      const customRoles = [
        ...new Set(bindings.map((b) => b.role).filter((r) => !r.startsWith("roles/"))),
      ];
      const customRolePermissions = Object.fromEntries(
        await Promise.all(
          customRoles.map(async (role) => [role, await getCustomRolePermissions(role)]),
        ),
      );

      const audit = auditProductionPolicy({
        projectId: SANDBOX_PROJECT_ID,
        policy: { bindings },
        customRolePermissions,
      });

      // The account this tier authenticates as holds roles/owner here, so a
      // compliant verdict would mean the control is not working — this is
      // the refusal path, proven against reality rather than a fixture.
      expect(audit.compliant).toBe(false);
      if (audit.compliant) throw new Error("unreachable");

      expect(audit.offending.length).toBeGreaterThan(0);
      for (const binding of audit.offending) {
        expect(binding.principal).not.toMatch(/^serviceAccount:/);
        expect(binding.verbs.length).toBeGreaterThan(0);
      }
      expect(audit.refusal).toContain(SANDBOX_PROJECT_ID);
      expect(audit.refusal).toContain("Nothing was changed");
    },
  );
});

describe("the staging composition, against the real provider", () => {
  const planned: PlannedResource[] = [];
  let operations: Record<string, number> = {};

  it(
    "previews as creates and nothing else",
    { timeout: PREVIEW_TIMEOUT_MS },
    async () => {
      await withFixtureStack(
        {
          fixture: "staging-environment",
          stackName: "ep7-preview",
          config: {
            service: "int-ep7",
            developersGroup: "int-ep7-devs@example.com",
          },
        },
        async (stack) => {
          const result = await stack.preview({ onEvent: collectPlanned(planned) });
          operations = result.changeSummary;
        },
      );

      // Preview-only is a property, not a hope: anything but creates in the
      // plan would mean state or reality already held something of ours.
      const kinds = Object.keys(operations).filter((op) => operations[op] > 0);
      expect(kinds).toEqual(["create"]);
    },
  );

  it("plans the boundary's staging half: bucket, deploy grant, state access", () => {
    // The provider accepted every input — reaching here at all is the
    // headline. The details pin what was sent, matching what the offline
    // mocks asserted, so the two tiers cannot quietly diverge.
    const bucket = planned.find((r) => r.type === "gcp:storage/bucket:Bucket");
    expect(bucket).toBeDefined();
    expect(bucket?.inputs.name).toBe("int-ep7-staging-state");
    expect(bucket?.inputs.project).toBe("int-ep7-staging");
    // toMatchObject: the engine annotates planned inputs with `__defaults`.
    expect(bucket?.inputs.versioning).toMatchObject({ enabled: true });
    expect(bucket?.inputs.publicAccessPrevention).toBe("enforced");

    const grants = planned
      .filter((r) => r.type === "gcp:projects/iAMMember:IAMMember")
      .map((r) => ({ role: r.inputs.role, member: r.inputs.member }));
    expect(grants).toEqual([
      { role: "roles/run.developer", member: "group:int-ep7-devs@example.com" },
    ]);

    const bucketGrants = planned
      .filter((r) => r.type === "gcp:storage/bucketIAMMember:BucketIAMMember")
      .map((r) => ({ role: r.inputs.role, member: r.inputs.member }));
    expect(bucketGrants).toEqual([
      { role: "roles/storage.objectAdmin", member: "group:int-ep7-devs@example.com" },
    ]);
  });
});
