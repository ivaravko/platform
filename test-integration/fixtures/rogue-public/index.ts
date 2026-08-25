import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

/**
 * A stack that bypasses the component entirely. **This stack must FAIL CR-03.**
 *
 * The policy pack exists for exactly this: a team that reaches past
 * `SecureContainerService` for raw `gcp.*` resources. Nothing here is
 * accidental — it is what someone writes when they want a public service and
 * have not read the guardrails.
 *
 * Note what makes it the *hard* case rather than a strawman. The service is
 * auto-named, so its name is an output that does not exist at plan time, and
 * the binding references it by `service.name`. There is no literal string for a
 * rule to match on: the only thing connecting this binding to this service is
 * the engine's dependency edge. If CR-03 resolved by name alone it would find
 * nothing here and pass — and the rule's own comment says unresolvable must
 * mean unjustified, precisely so that failing to wire the reference is not an
 * escape hatch.
 *
 * The description is deliberately ordinary. It is not the justification prefix
 * the rule looks for, so there is nothing to excuse the public binding.
 */

const config = new pulumi.Config();

const service = new gcp.cloudrunv2.Service("rogue", {
  location: config.require("location"),
  ingress: "INGRESS_TRAFFIC_ALL",
  description: "A service someone shipped in a hurry.",
  template: {
    serviceAccount: config.require("serviceAccountEmail"),
    containers: [{ image: config.require("image") }],
  },
});

new gcp.cloudrunv2.ServiceIamMember("rogue-public-invoker", {
  location: service.location,
  // The dependency edge CR-03 must follow. Auto-naming means this is an
  // unresolved output at plan time, not a string.
  name: service.name,
  role: "roles/run.invoker",
  member: "allUsers",
});

export const serviceName = service.name;
