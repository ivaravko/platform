import * as gcp from "@pulumi/gcp";
// Deep import, not the package root: @pulumi/policy@1.21.0 ships a broken
// barrel whose proxy.d.ts is `export {}`, failing tsc with TS2305. Same
// workaround, same reasoning, as gcp-components' src/policy/policies.ts.
import {
  type ResourceValidationPolicy,
  validateResourceOfType,
} from "@pulumi/policy/policy";

/**
 * EP-03's bypass layer. The `WorkloadIdentity` component never creates a key
 * and exposes no way to ask for one; this rule catches the hand that reaches
 * around the component and declares a raw `gcp.serviceaccount.Key` in a
 * bootstrap stack.
 */

/** Fires on presence: no configuration of a key is acceptable here. */
export const checkNoServiceAccountKey = (
  report: (message: string, urn?: string) => void,
): void => {
  report(
    "EP-03: no service account key exists anywhere in the deploy path. A key " +
      "is a long-lived credential that can leave CI; Workload Identity " +
      "Federation is the only supported way for CI to authenticate.",
  );
};

export const noServiceAccountKeys: ResourceValidationPolicy = {
  name: "ep03-no-service-account-keys",
  description:
    "A bootstrap stack must not create a service-account key; CI authenticates by federation.",
  enforcementLevel: "mandatory",
  validateResource: validateResourceOfType(
    gcp.serviceaccount.Key,
    (_props, _args, report) => {
      checkNoServiceAccountKey(report);
    },
  ),
};
