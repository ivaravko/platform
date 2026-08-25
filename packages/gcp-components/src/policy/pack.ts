// Deep import, not the package root — see the note in ./policies.
import { PolicyPack } from "@pulumi/policy/policy";
import { allPolicies } from "./policies";

/**
 * Constructs the CrossGuard policy pack.
 *
 * A factory rather than a top-level `new`: the `PolicyPack` constructor
 * registers with the Pulumi engine, so importing this module must not have that
 * side effect. Only the pack entry point calls it.
 */
export const createPolicyPack = (): PolicyPack =>
  new PolicyPack("runway-gcp", { policies: allPolicies });
