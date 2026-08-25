import { SecureContainerService } from "@runway/gcp-components";
import * as pulumi from "@pulumi/pulumi";

/**
 * The justified-public path. **This stack must PASS the policy pack.**
 *
 * It is the half of CR-03 that offline tests cannot reach. The component grants
 * `allUsers` the invoker role and records the justification on the service's
 * description — but the binding names the service by a **provider-generated**
 * name, which does not exist until the engine assigns it. The stack-scoped rule
 * therefore resolves binding to service through the engine's dependency edges,
 * and `pulumi.runtime.setMocks()` supplies no edges at all.
 *
 * Run over mocked output the rule reports a violation on this perfectly
 * compliant stack — a fiction, not a finding, which is why
 * `stack-compliance.test.ts` excludes it. A real preview builds a real graph,
 * so a pass here means the edge resolved and the justification was found.
 */

const config = new pulumi.Config();

const service = new SecureContainerService("integration-public", {
  location: config.require("location"),
  image: config.require("image"),
  serviceAccountEmail: config.require("serviceAccountEmail"),
  publicAccess: {
    justification:
      "Integration fixture for CR-02/CR-03: exercises the justified-public path.",
  },
});

export const serviceName = service.service.name;
export const isPublic = service.isPublic;
