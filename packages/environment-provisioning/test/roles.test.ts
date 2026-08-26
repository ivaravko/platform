import { describe, expect, it } from "vitest";
import {
  DEPLOY_PERMISSIONS,
  deployPermissionsGranted,
  isDeployCapable,
} from "../src";

/**
 * E1: what counts as deploy-capable. EP-01, EP-02 and EP-06 all turn on this
 * one answer, so a wrong answer here makes three controls wrong in the same
 * direction — silently permissive. The check matches permissions, not role
 * names, which is the whole control: `roles/editor` grants every deploy verb
 * without "run" appearing anywhere in its name.
 */

describe("EP-01/EP-02/EP-06: the deploy permission set", () => {
  it("names exactly the three deploy verbs the spec states", () => {
    // The reference is roles/run.admin: create and update are what "deploy"
    // means, and setIamPolicy grants the ability to grant the rest.
    expect([...DEPLOY_PERMISSIONS].toSorted()).toEqual([
      "run.services.create",
      "run.services.setIamPolicy",
      "run.services.update",
    ]);
  });

  it.each([
    ["roles/run.admin", true],
    ["roles/run.developer", true],
    ["roles/owner", true],
    // The case a name-based check has no way to see: nothing in the name
    // says Cloud Run, and every deploy verb is granted.
    ["roles/editor", true],
    // Genuinely harmless: can look, cannot touch.
    ["roles/run.viewer", false],
    ["roles/logging.viewer", false],
  ])("decides %s → deploy-capable: %s", (role, capable) => {
    expect(isDeployCapable({ role })).toBe(capable);
  });

  it("catches a custom role granting a deploy verb, however it is named", () => {
    // The name says nothing about deploying; the permissions say everything.
    expect(
      isDeployCapable({
        role: "projects/acme-prd/roles/costReporting",
        permissions: ["bigquery.jobs.create", "run.services.update"],
      }),
    ).toBe(true);
  });

  it("treats setIamPolicy alone as deploy-capable", () => {
    // A principal who can rewrite the service's IAM can grant themselves the
    // rest. Escalation-capable is deploy-capable.
    expect(
      isDeployCapable({
        role: "projects/acme-prd/roles/policyEditor",
        permissions: ["run.services.setIamPolicy"],
      }),
    ).toBe(true);
  });

  it("reports which verbs a grant carries, for the refusal message", () => {
    // EP-06's refusal names every offending binding; naming the verbs is what
    // makes the message actionable rather than merely correct.
    expect(deployPermissionsGranted({ role: "roles/run.developer" })).toEqual([
      "run.services.create",
      "run.services.update",
    ]);
    expect(deployPermissionsGranted({ role: "roles/run.viewer" })).toEqual([]);
  });

  it("prefers resolved permissions over the stated table when both exist", () => {
    // If a caller has resolved a predefined role from the live API, that
    // resolution is truer than the table written at authoring time.
    expect(
      isDeployCapable({ role: "roles/run.admin", permissions: ["run.services.get"] }),
    ).toBe(false);
  });
});

describe("EP-01/EP-02/EP-06: failure injection — the silently-permissive direction", () => {
  it("does not flag a role merely because its name contains 'run'", () => {
    // The false-positive direction is how a control gets switched off: a
    // check that cries wolf on runtimeconfig.admin gets disabled, and then
    // it catches nothing at all.
    expect(isDeployCapable({ role: "roles/runtimeconfig.admin" })).toBe(false);
    expect(
      isDeployCapable({
        role: "projects/acme-prd/roles/RunOperator",
        permissions: ["run.jobs.run", "runtimeconfig.configs.update"],
      }),
    ).toBe(false);
  });

  it("refuses to decide a custom role whose permissions were not resolved", () => {
    // "Unknown" must never collapse to "harmless" — that is the silently
    // permissive answer. It must not collapse to "capable" either, or the
    // control cries wolf. The caller resolves the role, then asks again.
    expect(() =>
      isDeployCapable({ role: "projects/acme-prd/roles/mystery" }),
    ).toThrow(/resolve/i);
  });
});
