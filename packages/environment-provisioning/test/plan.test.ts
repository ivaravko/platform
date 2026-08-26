import { describe, expect, it } from "vitest";
import { serviceCompleteness } from "../src";

/**
 * E6 / EP-07: a service with no production environment is incomplete, and
 * that is a fact someone has read, not a state nobody noticed. A report, not
 * a refusal — refusing would block the adoption path the option exists to
 * support.
 */

describe("EP-07: a service without production is reported incomplete", () => {
  it("names exactly the controls that are not yet enforced", () => {
    const status = serviceCompleteness({ production: false });

    expect(status.complete).toBe(false);
    // The four controls that are inert without a production project. EP-04
    // and EP-05 apply to staging from the first run, so they are not here.
    expect(status.notEnforced).toEqual(["EP-01", "EP-02", "EP-03", "EP-06"]);
  });

  it("reports a service with production as complete — failure-injected", () => {
    // The other half: the incomplete report must come from the absence, not
    // from the reporter always saying so.
    const status = serviceCompleteness({ production: true });

    expect(status.complete).toBe(true);
    expect(status.notEnforced).toEqual([]);
  });
});
