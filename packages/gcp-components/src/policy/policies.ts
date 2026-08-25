import * as gcp from "@pulumi/gcp";
// Imported from "@pulumi/policy/policy", not the package root, and deliberately.
// @pulumi/policy@1.21.0 ships a broken barrel: index.d.ts re-exports
// unknownCheckingProxy and UnknownValueError from "./proxy", whose .d.ts is
// literally `export {};` — the declarations were stripped, though proxy.js does
// export them at runtime. Importing the root fails `tsc` with TS2305.
// The alternative was skipLibCheck, which would stop checking @pulumi/pulumi and
// @pulumi/gcp declarations too — the very thing C2 verified. 1.21.0 is the
// latest, so there is no fixed version to move to.
import {
  type ResourceValidationPolicy,
  type StackValidationPolicy,
  validateResourceOfType,
  validateStackResourcesOfType,
} from "@pulumi/policy/policy";
import {
  checkGrantedRole,
  checkNoServiceAccountKey,
} from "./service-account-rules";
import {
  checkBinaryAuthorization,
  checkInvokerIamDisabled,
  checkPublicInvokerBindings,
  checkRuntimeServiceAccount,
  checkServiceIngress,
} from "./cloud-run-rules";

/**
 * The policy definitions, separate from the `PolicyPack` that carries them.
 *
 * Constructing a `PolicyPack` registers it with the Pulumi engine, so building
 * one inside a unit test would need a running engine. Exporting the array on its
 * own keeps the wiring — names, enforcement level, which rule is attached to
 * which resource type — assertable offline.
 */

/** Every policy is blocking. An advisory guardrail is a report, not a guardrail. */
const ENFORCEMENT = "mandatory" as const;

export const resourcePolicies: ResourceValidationPolicy[] = [
  {
    name: "cr01-cr03-public-ingress-requires-justification",
    description:
      "Cloud Run ingress INGRESS_TRAFFIC_ALL requires a justification recorded in description.",
    enforcementLevel: ENFORCEMENT,
    validateResource: validateResourceOfType(gcp.cloudrunv2.Service, (props, _args, report) => {
      checkServiceIngress(props, report);
    }),
  },
  {
    name: "cr05-invoker-iam-never-disabled",
    description: "Cloud Run must not disable the IAM permission check on run.routes.invoke.",
    enforcementLevel: ENFORCEMENT,
    validateResource: validateResourceOfType(gcp.cloudrunv2.Service, (props, _args, report) => {
      checkInvokerIamDisabled(props, report);
    }),
  },
  {
    name: "cr04-runtime-service-account-is-user-managed",
    description:
      "Cloud Run must run as a user-managed service account, never a Google-managed default.",
    enforcementLevel: ENFORCEMENT,
    validateResource: validateResourceOfType(gcp.cloudrunv2.Service, (props, _args, report) => {
      checkRuntimeServiceAccount(props, report);
    }),
  },
  {
    name: "cr09-binary-authorization-breakglass-forbidden",
    description: "Cloud Run must not bypass Binary Authorization with a breakglass justification.",
    enforcementLevel: ENFORCEMENT,
    validateResource: validateResourceOfType(gcp.cloudrunv2.Service, (props, _args, report) => {
      checkBinaryAuthorization(props, report);
    }),
  },
  {
    name: "sa01-no-user-managed-service-account-keys",
    description:
      "A user-managed service-account key is a long-lived credential that leaves the project.",
    enforcementLevel: ENFORCEMENT,
    validateResource: validateResourceOfType(gcp.serviceaccount.Key, (_props, _args, report) => {
      checkNoServiceAccountKey(report);
    }),
  },
  {
    name: "sa03-no-over-privileged-role-grants",
    description:
      "A raw IAM binding must not grant a project-wide or administrative role.",
    enforcementLevel: ENFORCEMENT,
    validateResource: validateResourceOfType(gcp.projects.IAMMember, (props, _args, report) => {
      checkGrantedRole(props, report);
    }),
  },
];

export const stackPolicies: StackValidationPolicy[] = [
  {
    name: "cr03-public-invoker-binding-requires-justification",
    description:
      "An allUsers or allAuthenticatedUsers run.invoker binding requires a justification on its service.",
    enforcementLevel: ENFORCEMENT,
    // Stack-scoped of necessity: a policy on the IAM member sees only its own
    // props, and the justification lives on the service it points at.
    validateStack: validateStackResourcesOfType(
      gcp.cloudrunv2.ServiceIamMember,
      (_members, args, report) => {
        checkPublicInvokerBindings(args.resources, report);
      },
    ),
  },
];

/** Every policy in the pack, in the order the pack registers them. */
export const allPolicies: (ResourceValidationPolicy | StackValidationPolicy)[] = [
  ...resourcePolicies,
  ...stackPolicies,
];
