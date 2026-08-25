import { describe, expect, it, vi } from "vitest";
import {
  checkGrantedRole,
  checkNoServiceAccountKey,
} from "../../src/policy/service-account-rules";

/** The bypass layer for service accounts: raw `gcp.*` resources. */

const report = () => vi.fn<(message: string, urn?: string) => void>();

describe("SA-01: raw service-account keys are rejected", () => {
  it("fires on the resource existing at all", () => {
    // There is no configuration of a key that makes it acceptable, so the rule
    // takes no props — it fires on presence.
    const r = report();
    checkNoServiceAccountKey(r);
    expect(r).toHaveBeenCalledOnce();
  });

  it("names Workload Identity as the alternative", () => {
    const r = report();
    checkNoServiceAccountKey(r);
    expect(r.mock.calls[0][0]).toMatch(/Workload Identity/);
  });
});

describe("SA-03: raw IAM bindings are held to the same role rule", () => {
  it.each([
    ["roles/owner", "roles/owner"],
    ["roles/editor", "roles/editor"],
    ["an admin role", "roles/iam.serviceAccountAdmin"],
  ])("rejects %s", (_label, role) => {
    const r = report();
    checkGrantedRole({ role, member: "serviceAccount:x@p.iam.gserviceaccount.com" }, r);
    expect(r).toHaveBeenCalledOnce();
  });

  it("passes a narrow role", () => {
    const r = report();
    checkGrantedRole({ role: "roles/run.invoker" }, r);
    expect(r).not.toHaveBeenCalled();
  });

  it("ignores a binding with no role rather than guessing", () => {
    const r = report();
    checkGrantedRole({}, r);
    expect(r).not.toHaveBeenCalled();
  });

  it("applies the component's own validator, so the two cannot drift", () => {
    // The message originates in assertGrantableRoles. If the policy grew its
    // own copy of the rule, this wording would stop matching.
    const r = report();
    checkGrantedRole({ role: "roles/storage.admin" }, r);
    expect(r.mock.calls[0][0]).toMatch(/administrative/);
  });
});
