import { type DeployPermission, deployPermissionsGranted } from "./roles";

/**
 * EP-06: the audit that refuses and never repairs.
 *
 * A read-only pass over an adopted production project's IAM policy. It
 * reports every binding that grants a deploy-capable role to a human
 * principal, and it changes nothing — silently stripping a pre-existing
 * binding could lock out the team that granted it, and this module has no
 * way to know why it exists. Remediation is a decision for a human who knows
 * the project's history.
 *
 * Structurally incapable of repair: this package has no runtime dependency,
 * so there is no client through which a write could happen. Asserted by
 * test, not by review.
 */

/** One binding as it appears in a GCP IAM policy. */
export interface IamBinding {
  readonly role: string;
  readonly members: readonly string[];
}

export interface IamPolicy {
  readonly bindings: readonly IamBinding[];
}

export interface AuditProductionPolicyOptions {
  /** The adopted project, named in the refusal so the operator knows where. */
  readonly projectId: string;

  readonly policy: IamPolicy;

  /**
   * Resolved permissions for custom roles appearing in the policy.
   *
   * Required for any custom role a human-reachable principal holds: the
   * audit throws rather than guessing, because "unknown" collapsing to
   * "clean" is exactly how EP-06 would report success while being false.
   * Custom roles held only by service accounts never need resolving.
   */
  readonly customRolePermissions?: Readonly<Record<string, readonly string[]>>;

  /**
   * Principals that are the CI deploy identity and therefore expected to
   * hold a deploy role — typically the deployer service account, which is
   * exempt by type anyway, but a team routing CI through a group can name it
   * here rather than getting a refusal about their own pipeline.
   */
  readonly ciIdentities?: readonly string[];
}

export interface OffendingBinding {
  readonly principal: string;
  readonly role: string;
  /** Which deploy verbs the role grants — what makes the refusal actionable. */
  readonly verbs: readonly DeployPermission[];
}

export type AuditResult =
  | { readonly compliant: true }
  | {
      readonly compliant: false;
      readonly offending: readonly OffendingBinding[];
      /** The full refusal text, carrying the whole decision. */
      readonly refusal: string;
    };

/**
 * Is this principal reachable by a person?
 *
 * `serviceAccount:` is the one type that is not — the CI deployer is
 * expected to hold the deploy role. Everything else is treated as human:
 * `user:` and `group:` obviously, and also `domain:`, `allUsers` and
 * `allAuthenticatedUsers`, which are *sets* of humans. Unknown member types
 * land on the flagged side deliberately — the alternative is a new GCP
 * principal type silently passing the one audit that exists to catch it.
 *
 * `deleted:` principals are skipped: a deleted identity cannot authenticate,
 * so it cannot deploy, and flagging tombstones would make the control cry
 * wolf over bindings nobody can act through.
 */
const isHumanReachable = (member: string, ciIdentities: readonly string[]): boolean => {
  if (member.startsWith("deleted:")) return false;
  if (member.startsWith("serviceAccount:")) return false;
  return !ciIdentities.includes(member);
};

/** The spec's worked example, generalised: every binding, aligned, then why. */
const renderRefusal = (
  projectId: string,
  offending: readonly OffendingBinding[],
): string => {
  const width = Math.max(...offending.map((o) => o.principal.length)) + 5;
  const lines = offending.map((o) => `  ${o.principal.padEnd(width)}${o.role}`);

  return [
    `EP-06: ${projectId} already grants deploy access to human principals.`,
    "",
    ...lines,
    "",
    "Adopting it would leave EP-01 unenforced — a developer could deploy to production",
    "by hand, which is the one thing this environment exists to prevent.",
    "",
    "Nothing was changed. To proceed, either remove these bindings, or adopt a",
    "different project as production.",
  ].join("\n");
};

/**
 * Audit an adopted production project's IAM policy against EP-06.
 *
 * Pure: reads the policy, returns a verdict, mutates nothing. Throws only
 * when a human-reachable principal holds a custom role whose permissions
 * were not supplied — the undecidable case, which must not pass.
 */
export const auditProductionPolicy = (
  options: AuditProductionPolicyOptions,
): AuditResult => {
  const ciIdentities = options.ciIdentities ?? [];
  const offending: OffendingBinding[] = [];

  for (const binding of options.policy.bindings) {
    const humans = binding.members.filter((member) =>
      isHumanReachable(member, ciIdentities),
    );
    if (humans.length === 0) {
      // Nothing about EP-06 turns on what this role grants — no person holds
      // it — so an unresolved custom role here is not an error.
      continue;
    }

    const verbs = deployPermissionsGranted({
      role: binding.role,
      permissions: options.customRolePermissions?.[binding.role],
    });
    if (verbs.length === 0) {
      continue;
    }

    offending.push(...humans.map((principal) => ({ principal, role: binding.role, verbs })));
  }

  if (offending.length === 0) {
    return { compliant: true };
  }
  return {
    compliant: false,
    offending,
    refusal: renderRefusal(options.projectId, offending),
  };
};
