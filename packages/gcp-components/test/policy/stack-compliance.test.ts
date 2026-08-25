import { describe, expect, it } from "vitest";
import { resolve, resourcesFor } from "../setup";
import { SecureContainerService } from "../../src/container-service/secure-container-service";
import {
  checkBinaryAuthorization,
  checkInvokerIamDisabled,
  checkRuntimeServiceAccount,
  checkServiceIngress,
  type PolicyResourceLike,
} from "../../src/policy/cloud-run-rules";

/**
 * A stack built only from the component must pass its own policy pack.
 *
 * The spec states this criterion against a real `pulumi preview --policy-pack`,
 * which needs a stack and a sandbox GCP project (SPEC.md Open Question 3, still
 * unanswered). This is the offline half: the rules are run over the props the
 * component actually emits, so the two halves of the guardrail are checked
 * against each other rather than each against its own assumptions.
 *
 * **The stack-scoped CR-03 rule is excluded here, and that is a real limit.**
 * It resolves a binding to its service through the engine's dependency graph,
 * because a Cloud Run service's name is provider-generated and a mocked stack
 * therefore has nothing to match on. `pulumi.runtime.setMocks` supplies no
 * dependency edges at all, so running that rule over mocked output would report
 * a violation on a perfectly compliant stack — a fiction, not a finding. It is
 * covered by explicit dependency fixtures in `cloud-run.test.ts` instead, and
 * end-to-end only by the integration tier.
 *
 * What this also does not cover: that Pulumi loads and executes the pack.
 */

const SA = "api-runtime@my-proj.iam.gserviceaccount.com";
const IMAGE = "europe-west1-docker.pkg.dev/p/r/api:v1";
const SERVICE_TYPE = "gcp:cloudrunv2/service:Service";

/** Runs every rule over a stack, returning the violations reported. */
const violationsFor = (resources: readonly PolicyResourceLike[]): string[] => {
  const found: string[] = [];
  const report = (message: string): void => {
    found.push(message);
  };

  for (const resource of resources) {
    if (resource.type !== SERVICE_TYPE) {
      continue;
    }
    checkServiceIngress(resource.props, report);
    checkInvokerIamDisabled(resource.props, report);
    checkRuntimeServiceAccount(resource.props, report);
    checkBinaryAuthorization(resource.props, report);
  }
  // checkPublicInvokerBindings is deliberately excluded — see the note below.
  return found;
};

describe("a stack of only SecureContainerService passes its own policy pack", () => {
  it("reports zero violations for a private service", async () => {
    const svc = new SecureContainerService("compliant-private", {
      location: "europe-west1",
      image: IMAGE,
      serviceAccountEmail: SA,
    });
    await resolve(svc.service.ingress);
    expect(violationsFor(await resourcesFor("compliant-private"))).toEqual([]);
  });

  it("reports zero violations for a justified public service", async () => {
    const svc = new SecureContainerService("compliant-public", {
      location: "europe-west1",
      image: IMAGE,
      serviceAccountEmail: SA,
      publicAccess: { justification: "handles public webhooks from Stripe" },
    });
    await resolve(svc.service.ingress);
    const resources = await resourcesFor("compliant-public");
    // Guard: an empty stack would report zero violations too.
    expect(resources.length).toBeGreaterThanOrEqual(2);
    expect(violationsFor(resources)).toEqual([]);
  });

  it("reports zero violations with Binary Authorization enabled", async () => {
    const svc = new SecureContainerService("compliant-binauthz", {
      location: "europe-west1",
      image: IMAGE,
      serviceAccountEmail: SA,
      binaryAuthorization: { useDefault: true },
    });
    await resolve(svc.service.ingress);
    expect(violationsFor(await resourcesFor("compliant-binauthz"))).toEqual([]);
  });

  it("still catches a raw resource declared alongside compliant ones", async () => {
    // Proves the zero-violation results above mean the rules ran and found
    // nothing, rather than the rules quietly not running.
    const svc = new SecureContainerService("mixed-ok", {
      location: "europe-west1",
      image: IMAGE,
      serviceAccountEmail: SA,
    });
    await resolve(svc.service.ingress);
    const stack: PolicyResourceLike[] = [
      ...(await resourcesFor("mixed-ok")),
      {
        type: SERVICE_TYPE,
        name: "hand-written",
        props: { ingress: "INGRESS_TRAFFIC_ALL", labels: { "runway-public": "true" } },
      },
    ];
    const violations = violationsFor(stack);
    // Public with no justification, and no runtime service account.
    expect(violations).toHaveLength(2);
  });
});
