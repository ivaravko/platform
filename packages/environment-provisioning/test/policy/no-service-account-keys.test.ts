import { describe, expect, it, vi } from "vitest";
import {
  checkNoServiceAccountKey,
  noServiceAccountKeys,
} from "../../src/policy/no-service-account-keys";

/**
 * EP-03's bypass layer: a raw `gcp.serviceaccount.Key` declared in a
 * bootstrap stack. The component never creates one and exposes no way to ask;
 * this rule is what catches the hand that reaches around the component.
 */

const report = () => vi.fn<(message: string, urn?: string) => void>();

describe("EP-03: the policy rule rejects a raw service-account key", () => {
  it("fires on the resource existing at all", () => {
    // No configuration of a key is acceptable in the bootstrap path, so the
    // check takes no props — it fires on presence.
    const r = report();
    checkNoServiceAccountKey(r);
    expect(r).toHaveBeenCalledOnce();
  });

  it("names federation as the only path, and the control it protects", () => {
    const r = report();
    checkNoServiceAccountKey(r);
    expect(r.mock.calls[0][0]).toMatch(/federation/i);
    expect(r.mock.calls[0][0]).toMatch(/EP-03/);
  });

  it("is wired to the key resource type, at mandatory enforcement", () => {
    expect(noServiceAccountKeys.name).toBe("ep03-no-service-account-keys");
    expect(noServiceAccountKeys.enforcementLevel).toBe("mandatory");
  });
});
