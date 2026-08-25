import { beforeAll, describe, expect, it } from "vitest";
import {
  type IamPolicy,
  type ServiceResponse,
  getService,
  getServiceIamPolicy,
} from "../support/gcp-client";
import { assertSandbox } from "../support/sandbox";
import { stringAt, withDeployedStack } from "../support/stack";

/**
 * The hardened defaults, read back from Google on both paths.
 *
 * These assertions are transcriptions, not discoveries: the same readings were
 * taken by hand in `feb337b` and recorded in SPEC-secure-container-service.md.
 * That is what makes this task small — and it is also the argument for doing
 * it. A control verified by hand once is verified on the day someone remembered
 * to look.
 *
 * **Both paths in one file, deployed together.** A private service that reports
 * no public URL proves little on its own — a broken deployment reports nothing
 * either. The public service is the control: the same component, the same
 * assertions, opposite answers. If both came back identical, the component
 * would not be deciding anything.
 */

assertSandbox();

/** Two deploys, four API reads and two teardowns. */
const DEPLOY_TIMEOUT_MS = 900_000;

const INVOKER_ROLE = "roles/run.invoker";

/**
 * The marker the component writes ahead of a justification, duplicated here on
 * purpose.
 *
 * It is not merely formatting: `checkPublicInvokerBindings` matches on this
 * exact prefix to decide whether a public binding is justified, so it is the
 * wire format of a contract between the component and the policy pack. Written
 * out here rather than imported, so that changing it fails this test — a silent
 * change would leave the pack rejecting stacks the component still produces.
 */
const PUBLIC_ACCESS_PREFIX = "Public access justified: ";

/** Every member granted the invoker role, across all bindings. */
const invokerMembers = (policy: IamPolicy): readonly string[] =>
  (policy.bindings ?? [])
    .filter((binding) => binding.role === INVOKER_ROLE)
    .flatMap((binding) => binding.members ?? []);

describe("hardened defaults, verified against the live API", () => {
  let privateService: ServiceResponse;
  let privatePolicy: IamPolicy;
  let publicService: ServiceResponse;
  let publicPolicy: IamPolicy;
  let publicUri: string;
  let publicStatus: number;
  let expectedJustification: string;

  beforeAll(async () => {
    await withDeployedStack(
      { fixture: "private-service", stackName: "controls-private" },
      async ({ outputs }) => {
        const name = String(outputs.serviceName);
        privateService = await getService(name);
        privatePolicy = await getServiceIamPolicy(name);
      },
    );

    await withDeployedStack(
      { fixture: "public-service", stackName: "controls-public" },
      async ({ outputs }) => {
        const name = String(outputs.serviceName);
        publicService = await getService(name);
        publicPolicy = await getServiceIamPolicy(name);
        publicUri = String(outputs.uri);
        expectedJustification = String(outputs.justification);

        // Reached while the service is still up. CR-07 is about the URL being
        // resolvable, and the only honest way to check that is to fetch it.
        publicStatus = (await fetch(publicUri)).status;
      },
    );
  }, DEPLOY_TIMEOUT_MS);

  describe("CR-01: ingress", () => {
    it("CR-01: the private service admits only internal load-balancer traffic", () => {
      expect(privateService.ingress).toBe(
        "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      );
    });

    it("CR-01: the public service admits all traffic, so the default is a decision", () => {
      expect(publicService.ingress).toBe("INGRESS_TRAFFIC_ALL");
    });
  });

  describe("CR-03: invoker bindings", () => {
    it("CR-03: the private service has no invoker binding at all", () => {
      // Not "has no allUsers binding" — has none. An empty policy is the
      // assertion, and a policy granting some other principal would be a
      // finding too.
      expect(invokerMembers(privatePolicy)).toEqual([]);
    });

    it("CR-03: the justified public service has exactly one, and it is allUsers", () => {
      expect(invokerMembers(publicPolicy)).toEqual(["allUsers"]);
    });
  });

  describe("CR-07: default URI resolution", () => {
    it("CR-07: the private service is assigned no URL", () => {
      // The API omits `urls` entirely rather than returning an empty list, so
      // the check has to accept both shapes without treating "absent" and
      // "present but empty" as different findings.
      const urls = privateService.urls;
      expect(Array.isArray(urls) ? urls : []).toEqual([]);
    });

    it("CR-07: the public service serves on its URL", () => {
      expect(publicUri).toMatch(/^https:\/\//);
      expect(publicStatus).toBe(200);
    });
  });

  describe("CR-08: the justification is recorded on the resource", () => {
    it("CR-08: the private service records no description and no public label", () => {
      expect(stringAt(privateService, "description") ?? "").toBe("");
      expect(stringAt(privateService, "labels", "runway-public")).toBeUndefined();
    });

    it("CR-08: the public service records the justification verbatim", () => {
      // The whole string, not `toContain` — a truncated or reworded
      // justification is a worse audit trail than an obviously missing one,
      // because it reads as deliberate. Equality catches both, and it also
      // pins the prefix the policy pack matches on.
      expect(stringAt(publicService, "description")).toBe(
        `${PUBLIC_ACCESS_PREFIX}${expectedJustification}`,
      );
    });

    it("CR-08: the public service carries the runway-public label", () => {
      expect(stringAt(publicService, "labels", "runway-public")).toBe("true");
    });
  });
});
