import type { OpMap } from "@pulumi/pulumi/automation";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type PlannedResource,
  collectPlanned,
  onlyResourceOfType,
  stringAt,
  withFixtureStack,
} from "../support/stack";
import { assertSandbox } from "../support/sandbox";

/**
 * Tier A: the provider still accepts the resource shapes the components emit.
 *
 * The pull-request suite plans these same resources against
 * `pulumi.runtime.setMocks()`, which accepts anything — a field renamed in a
 * `@pulumi/gcp` release, or removed from the Google API, passes there and fails
 * on the day someone deploys. Here the real provider validates the inputs
 * against its real schema before the plan can complete.
 *
 * **What this proves and what it does not.** A completed preview means Google's
 * provider accepted what we sent. It does not mean GCP *enforces* any of it:
 * nothing is created, no policy is evaluated. Enforcement is Tier B's job, and
 * conflating the two is how a suite comes to read as more proof than it is.
 */

// Module scope: a misconfigured environment fails before a workspace exists,
// not midway through planning.
assertSandbox();

const CLOUD_RUN_SERVICE = "gcp:cloudrunv2/service:Service";
const SECURE_CONTAINER_SERVICE = "runway:gcp:SecureContainerService";

/** Preview against real GCP is a network round trip, not a unit test. */
const PREVIEW_TIMEOUT_MS = 180_000;

describe("provider contract: the private path plans against real GCP", () => {
  const planned: PlannedResource[] = [];
  let summary: OpMap;

  beforeAll(async () => {
    // One preview for the whole file. Each assertion below reads a different
    // part of the same plan, and previewing per test would multiply a ~10s
    // round trip by the number of controls for no additional coverage.
    await withFixtureStack(
      { fixture: "private-service", stackName: "provider-contract" },
      async (stack) => {
        const result = await stack.preview({
          onEvent: collectPlanned(planned),
        });
        summary = result.changeSummary;
      },
    );
  }, PREVIEW_TIMEOUT_MS);

  it("completes, which is itself the provider accepting every input", () => {
    // A schema violation aborts the preview, so reaching here at all is the
    // headline assertion. The rest describes *what* was accepted.
    expect(planned.length).toBeGreaterThan(0);
  });

  it("plans creates and nothing else", () => {
    // Five since D4: the component, its Cloud Run service, the service account
    // the fixture now builds, and the resources those pull in. A stack that
    // plans an update or a delete is a stack with leftover state
    // from a previous run — which would silently weaken every assertion below,
    // since an unchanged resource carries no inputs to check.
    expect(summary.create).toBe(5);
    expect(summary.update).toBeUndefined();
    expect(summary.delete).toBeUndefined();
  });

  it("plans the component and its Cloud Run service", () => {
    const types = planned.map((resource) => resource.type);
    expect(types).toContain(SECURE_CONTAINER_SERVICE);
    expect(types).toContain(CLOUD_RUN_SERVICE);
  });

  describe("CR-01: the ingress restriction survives to the provider", () => {
    it("sends internal-load-balancer ingress, not a default", () => {
      const service = onlyResourceOfType(planned, CLOUD_RUN_SERVICE);
      expect(service.inputs.ingress).toBe(
        "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      );
    });
  });

  describe("CR-07: default URI resolution is disabled on the private path", () => {
    it("sends defaultUriDisabled", () => {
      const service = onlyResourceOfType(planned, CLOUD_RUN_SERVICE);
      expect(service.inputs.defaultUriDisabled).toBe(true);
    });
  });

  describe("CR-03: no invoker binding is planned without a justification", () => {
    it("plans no IAM member resource at all", () => {
      // Not "plans a binding with safe contents" — plans *none*. The private
      // path grants no invoker, and an absent resource is the assertion.
      const iam = planned.filter((resource) =>
        resource.type.includes("cloudrunv2/serviceIamMember"),
      );
      expect(iam).toEqual([]);
    });
  });

  describe("CR-04: the runtime identity is user-managed", () => {
    it("sends a service account on the template", () => {
      const service = onlyResourceOfType(planned, CLOUD_RUN_SERVICE);
      const serviceAccount = stringAt(service.inputs, "template", "serviceAccount");

      expect(serviceAccount).toBeDefined();
      // The default compute SA is the thing CR-04 exists to prevent, and it is
      // the one a careless refactor would fall back to.
      expect(serviceAccount).not.toMatch(/-compute@developer\./);
    });
  });
});
