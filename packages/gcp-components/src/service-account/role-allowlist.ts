/**
 * Validation for roles granted to a runway-managed service account. Control SA-03.
 *
 * **The allowlist starts empty, deliberately.** No roles are granted unless a
 * caller names them. A positive allowlist nobody has vetted grants confidence
 * without cover — the same reasoning that makes CR-04's hint list cosmetic and
 * its positive rule the actual boundary. Here the honest boundary is the denial
 * set, because that is what has actually been reasoned about.
 *
 * What is denied is narrow and defensible: the two project-wide roles, and
 * anything ending in `admin`. What is allowed is everything else, and the
 * caller owns that choice — which is the true state of affairs, stated rather
 * than dressed up as a vetted list.
 */

/** `roles/<name>`, or a custom role under a project or organization. */
const ROLE_SHAPE =
  /^(roles\/[a-zA-Z][\w.]*|(projects|organizations)\/[a-z0-9-]+\/roles\/[\w.]+)$/;

/** Project-wide roles. Neither is ever an appropriate runtime identity. */
const PROJECT_WIDE = new Set(["roles/owner", "roles/editor"]);

/** Everything after the last dot — `iam.serviceAccountAdmin` → `serviceAccountAdmin`. */
const finalSegment = (role: string): string =>
  role.slice(role.lastIndexOf("/") + 1).split(".").pop() ?? "";

/**
 * Whether a role confers administrative control.
 *
 * Matched on the **final segment ending** in `admin`, not on the role
 * containing it: `roles/storage.admin` and `roles/iam.serviceAccountAdmin` are
 * administrative, while a hypothetical `roles/cloudsql.admin.viewer` is not.
 * Substring matching would reject the second, and rejecting things that are
 * fine is how a control gets switched off.
 */
const isAdministrative = (role: string): boolean =>
  finalSegment(role).toLowerCase().endsWith("admin");

/** What to do about it. Every rejection ends with this. */
const REMEDY =
  "Grant only the roles this identity needs, one at a time, and prefer the " +
  "narrowest role that works.";

/**
 * Throws unless every role is safe to grant a runtime identity.
 *
 * @param roles Roles the caller asked for.
 * @throws If any role is malformed, project-wide, or administrative.
 */
export function assertGrantableRoles(roles: readonly string[]): void {
  for (const role of roles) {
    if (!ROLE_SHAPE.test(role)) {
      throw new Error(
        `"${role}" is not a role identifier. Expected "roles/<name>" or a ` +
          `custom role such as "projects/<project>/roles/<name>". ${REMEDY}`,
      );
    }
    if (PROJECT_WIDE.has(role)) {
      throw new Error(
        `Role "${role}" grants project-wide control and is never an ` +
          `appropriate runtime identity. ${REMEDY}`,
      );
    }
    if (isAdministrative(role)) {
      throw new Error(
        `Role "${role}" is administrative: it can change who has access, ` +
          `not merely use the service. ${REMEDY}`,
      );
    }
  }
}
