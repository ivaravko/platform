import { ServiceEnvironment } from "@runway/environment-provisioning";
import * as pulumi from "@pulumi/pulumi";

/**
 * E7's staging fixture: the smallest stack that exercises the boundary's safe
 * half — one adopted project, its deploy grant, its state bucket (EP-04,
 * EP-05). Previewed, never deployed: plan OQ2 resolved bootstrap's
 * integration tier to read-and-preview only.
 *
 * Nothing here is defaulted from the ambient environment, same as every other
 * fixture: a stack that fell back to gcloud's active project would plan
 * against wherever the operator happened to be pointed.
 */

const config = new pulumi.Config();

const staging = new ServiceEnvironment("staging", {
  service: config.require("service"),
  environment: "staging",
  location: config.require("location"),
  deployableBy: { humans: { group: config.require("developersGroup") } },
});

export const project: pulumi.Output<string> = staging.project;
export const stateBucket: pulumi.Output<string> = staging.stateBucket.name;
