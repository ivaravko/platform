import { beforeAll, describe, expect, it } from "vitest";
import { type ServiceResponse, getService } from "../support/gcp-client";
import { assertSandbox } from "../support/sandbox";
import { withDeployedStack } from "../support/stack";

/**
 * CR-06: `deletionProtection` is a provider-side field, not a GCP one.
 *
 * The divergence **is** the assertion. Pulumi state records `true`; the Cloud
 * Run v2 API returns `null` for the same deployed service. It blocks
 * `pulumi destroy` and `terraform destroy` and nothing else — `gcloud run
 * services delete` and the Console remove the service regardless.
 *
 * That is why this tier reads through the API rather than through Pulumi state.
 * A harness that asserted on state would report CR-06 as a verified property of
 * the resource, which it is not, and the mapping's *Known gaps* entry for it
 * would look like an oversight instead of a finding.
 *
 * **If this test starts failing because the API returns a value, the control
 * got stronger and the mapping is stale.** That is a real outcome to act on,
 * not a flake to retry — which is the whole reason the null is asserted
 * explicitly rather than merely tolerated.
 */

assertSandbox();

/** A deploy, a read-back and a destroy against real GCP. */
const DEPLOY_TIMEOUT_MS = 600_000;

describe("CR-06: deletion protection, both sides of the round trip", () => {
  let stateValue: unknown;
  let deployed: ServiceResponse;

  beforeAll(async () => {
    await withDeployedStack(
      { fixture: "private-service", stackName: "cr06-deletion-protection" },
      async ({ outputs }) => {
        stateValue = outputs.deletionProtection;
        deployed = await getService(String(outputs.serviceName));
      },
    );
  }, DEPLOY_TIMEOUT_MS);

  it("CR-06: Pulumi state records the protection as requested", () => {
    expect(stateValue).toBe(true);
  });

  it("CR-06: the v2 API does not report it at all", () => {
    // Not toBeFalsy(): null and false are different answers. false would mean
    // GCP knows the field and it is off; null means GCP has no such field, and
    // only the second explains why the Console can still delete the service.
    expect(deployed.deletionProtection ?? null).toBeNull();
  });

  it("CR-06: the service really was deployed, so the null means something", () => {
    // Without this, a null could equally come from reading the wrong resource,
    // and the assertion above would pass for the wrong reason.
    expect(deployed.name).toBeDefined();
    expect(String(deployed.name)).toContain("integration-private");
  });
});
