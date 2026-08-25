import { SecureContainerService } from "@runway/gcp-components";
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

const service = new SecureContainerService("integration-private", {
  location: config.require("location"),
  image: config.require("image"),
  serviceAccountEmail: config.require("serviceAccountEmail"),
});

/**
 * Exported for the assertions, not for humans.
 *
 * `serviceName` is what the live-API client needs to read the deployed resource
 * back. `deletionProtection` is exported so a test can compare Pulumi's view
 * against the v2 API's — the CR-06 divergence, which is only visible when both
 * readings are available side by side.
 */
export const serviceName = service.service.name;
export const location = service.service.location;
export const deletionProtection = service.service.deletionProtection;
export const ingress = service.service.ingress;
export const isPublic = service.isPublic;
