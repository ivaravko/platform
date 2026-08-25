import {
  SecureContainerService,
  SecureServiceAccount,
} from "@runway/gcp-components";
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

/** The sandbox project, from provider config rather than a second copy here. */
const gcpProject = new pulumi.Config("gcp").require("project");
/**
 * The runtime identity, created per stack rather than reused.
 *
 * The component now takes a `SecureServiceAccount` rather than an email string
 * (D4), so the fixture creates one. That is a better test than passing the
 * pre-existing `runway-api` account: CR-04 is about the identity being
 * user-managed, and a stack that builds its own proves the component wires a
 * real account through rather than accepting whatever string it is handed.
 *
 * `accountId` is short on purpose — GCP caps it at 30 characters, and the
 * teardown path has to remove it too.
 */
const serviceAccount = new SecureServiceAccount("int-public-sa", {
  accountId: config.require("accountId"),
  project: gcpProject,
  description: "Runtime identity for the integration tier. Destroyed with the stack.",
});


/**
 * The justification text, exported so the assertions compare against the exact
 * string this stack asked for rather than a copy that can drift out of step.
 * CR-08 is about the justification being recorded *verbatim* on the resource.
 */
export const JUSTIFICATION =
  "Integration fixture for CR-02/CR-03/CR-08: exercises the justified-public path.";

/** See the note in the private fixture — CR-06 blocks destroy without this. */
const releaseForTeardown = config.getBoolean("releaseDeletionProtection") ?? false;

const service = new SecureContainerService("integration-public", {
  location: config.require("location"),
  image: config.require("image"),
  serviceAccount,
  publicAccess: { justification: JUSTIFICATION },
  deletionProtection: releaseForTeardown
    ? {
        disableJustification:
          "Integration fixture teardown: the tier destroys everything it creates.",
      }
    : true,
});

export const serviceAccountEmail = serviceAccount.email;
export const serviceName = service.service.name;
export const isPublic = service.isPublic;
export const uri = service.uri;
export const justification = JUSTIFICATION;
