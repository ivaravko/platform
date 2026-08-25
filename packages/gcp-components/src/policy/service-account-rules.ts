import { assertGrantableRoles } from "../service-account/role-allowlist";
import type { Report } from "./cloud-run-rules";

/**
 * Rules covering service-account misuse in raw `gcp.*` resources.
 *
 * `SecureServiceAccount` makes keys unreachable and validates roles, but only
 * for consumers who use it. These rules cover the ones who do not.
 */

/** The subset of an IAM binding these rules read. */
export interface IamMemberProps {
  readonly role?: string;
  readonly member?: string;
}

/**
 * SA-01 — user-managed service-account keys are never acceptable.
 *
 * A key is a long-lived credential that leaves the project: it can be copied
 * into a laptop, a CI variable, or a git repository, and nothing about its use
 * is attributable afterwards. Workload Identity is the supported path and it
 * has no such artefact. This rule fires on the resource's mere existence —
 * there is no configuration of a key that makes it acceptable.
 */
export const checkNoServiceAccountKey = (report: Report): void => {
  report(
    "This stack creates a user-managed service-account key. Keys are " +
      "long-lived credentials that leave the project and cannot be attributed " +
      "once copied. Use Workload Identity instead; SecureServiceAccount " +
      "exposes no way to create one.",
  );
};

/**
 * SA-03 — a raw IAM binding must not grant an over-privileged role.
 *
 * Applies the identical rule `SecureServiceAccount` applies at construction, by
 * calling the same function. Two implementations of one control would drift,
 * and the drift would be silent.
 */
export const checkGrantedRole = (props: IamMemberProps, report: Report): void => {
  if (props.role === undefined) {
    return;
  }
  try {
    assertGrantableRoles([props.role]);
  } catch (error) {
    report(
      `IAM binding grants ${props.member ?? "a member"} an unsafe role. ` +
        (error instanceof Error ? error.message : String(error)),
    );
  }
};
