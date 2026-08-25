import {
  SecureContainerService,
  SecureServiceAccount,
} from "@runway/gcp-components";
import * as pulumi from "@pulumi/pulumi";

/**
 * The private path, as a real stack program.
 *
 * This is the fixture the preview tier plans and the deploy tier deploys. It is
 * deliberately the smallest stack that still exercises the hardened defaults:
 * one `SecureContainerService` with no `publicAccess`, which is the
 * configuration CR-01, CR-03 and CR-07 all describe.
 *
 * **Nothing here is defaulted from the ambient environment.** `location`,
 * `image` and `serviceAccountEmail` are required Pulumi config, and the GCP
 * project comes from `gcp:project` pinned in `Pulumi.integration.yaml`. A stack
 * that fell back to gcloud's active project would deploy wherever the operator
 * happened to be pointed — which, on this machine, is a project holding live
 * workloads. Required config turns that into a startup error.
 *
 * Compiled to JavaScript before Pulumi ever sees it: `Pulumi.yaml` declares
 * `typescript: false`, because Pulumi's ts-node path dies under TypeScript 7.
 * See SPEC.md.
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
const serviceAccount = new SecureServiceAccount("int-private-sa", {
  accountId: config.require("accountId"),
  project: gcpProject,
  description: "Runtime identity for the integration tier. Destroyed with the stack.",
});


/**
 * Teardown needs this, and finding out why cost a real orphaned service.
 *
 * CR-06 defaults `deletionProtection` on, and the provider then refuses:
 * `cannot destroy service without setting deletion_protection=false`. So an
 * automated tier cannot deploy a protected service and simply destroy it — it
 * must first flip the flag and re-apply. The harness sets this immediately
 * before teardown and never during the assertions, so every control is observed
 * on a service that is genuinely protected.
 *
 * This uses the component's own justified escape hatch rather than reaching for
 * a raw resource, because the escape hatch is part of what CR-06 promises and
 * a tier that bypassed it would not be testing the component's real behaviour.
 */
const releaseForTeardown = config.getBoolean("releaseDeletionProtection") ?? false;

const service = new SecureContainerService("integration-private", {
  location: config.require("location"),
  image: config.require("image"),
  serviceAccount,
  deletionProtection: releaseForTeardown
    ? {
        disableJustification:
          "Integration fixture teardown: the tier destroys everything it creates.",
      }
    : true,
});

/**
 * Exported for the assertions, not for humans.
 *
 * `serviceName` is what the live-API client needs to read the deployed resource
 * back. `deletionProtection` is exported so a test can compare Pulumi's view
 * against the v2 API's — the CR-06 divergence, which is only visible when both
 * readings are available side by side.
 */
export const serviceAccountEmail = serviceAccount.email;
export const serviceName = service.service.name;
export const location = service.service.location;
export const deletionProtection = service.service.deletionProtection;
export const ingress = service.service.ingress;
export const isPublic = service.isPublic;
