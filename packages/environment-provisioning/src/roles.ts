/**
 * What counts as deploy-capable. The one answer EP-01, EP-02 and EP-06 all
 * turn on: a wrong answer here makes three controls wrong in the same
 * direction — silently permissive.
 *
 * The check matches **permissions, not role names**. `roles/editor` grants
 * every deploy verb without "run" appearing anywhere in its name, and a
 * custom role can grant `run.services.create` under any name at all. A
 * name-based check would wave both through while reporting success, which is
 * worse than no check.
 */

/**
 * The verbs that mean "deploy" for a service on this paved road.
 *
 * `roles/run.admin` is the reference: create and update are what deploying a
 * Cloud Run service is, and `setIamPolicy` is escalation — a principal who
 * can rewrite the service's IAM can grant themselves the rest.
 *
 * Deliberately absent: `roles/iam.serviceAccountUser`. Holding it alone
 * deploys nothing; it matters only in combination with the verbs above, which
 * the check already catches — and flagging everyone who merely impersonates a
 * service account would make the control cry wolf until it gets switched off.
 */
export const DEPLOY_PERMISSIONS = [
  "run.services.create",
  "run.services.update",
  "run.services.setIamPolicy",
] as const;

export type DeployPermission = (typeof DEPLOY_PERMISSIONS)[number];

/**
 * The predefined roles that grant a deploy verb, resolved to which verbs.
 *
 * Stated explicitly rather than fetched at runtime, per the spec: the IAM
 * roles API may be unavailable exactly when an audit runs, and an audit that
 * cannot decide is an audit that gets skipped. The cost is a maintenance
 * liability — Google can add a deploy-granting role this table has never
 * heard of — accepted and recorded here rather than discovered in an
 * incident.
 *
 * A predefined role absent from this table grants no deploy verb. That claim
 * is checkable against `gcloud iam roles describe`, which is exactly how
 * these entries were established.
 */
const DEPLOY_CAPABLE_PREDEFINED: Readonly<
  Record<string, readonly DeployPermission[]>
> = {
  "roles/run.admin": [
    "run.services.create",
    "run.services.update",
    "run.services.setIamPolicy",
  ],
  "roles/run.developer": ["run.services.create", "run.services.update"],
  // Deploys from source: builds, then creates or updates the service.
  "roles/run.sourceDeveloper": ["run.services.create", "run.services.update"],
  "roles/owner": [
    "run.services.create",
    "run.services.update",
    "run.services.setIamPolicy",
  ],
  // Everything but the IAM-modifying verbs — which still deploys.
  "roles/editor": ["run.services.create", "run.services.update"],
};

/** One role as it appears in an IAM binding, optionally resolved. */
export interface RoleGrant {
  /** `roles/...` for predefined; `projects/.../roles/...` etc. for custom. */
  readonly role: string;

  /**
   * The permissions the role grants, from its live definition.
   *
   * Required for custom roles — nothing about a custom role's name says what
   * it grants. When present it wins over the stated table even for a
   * predefined role, because a resolution from the API is truer than a table
   * written at authoring time.
   */
  readonly permissions?: readonly string[];
}

/**
 * The deploy verbs this grant carries — `[]` when it carries none.
 *
 * Returns the verbs rather than a bare boolean because EP-06's refusal names
 * every offending binding, and naming what each one grants is what makes the
 * message actionable rather than merely correct.
 *
 * Throws for a custom role whose permissions were not resolved. "Unknown"
 * must not collapse to "harmless" — that is the silently permissive answer —
 * and not to "capable" either, or the control cries wolf. The caller resolves
 * the role, then asks again.
 */
export const deployPermissionsGranted = (
  grant: RoleGrant,
): readonly DeployPermission[] => {
  const granted =
    grant.permissions ??
    (grant.role.startsWith("roles/")
      ? (DEPLOY_CAPABLE_PREDEFINED[grant.role] ?? [])
      : undefined);

  if (granted === undefined) {
    throw new Error(
      `Cannot decide whether ${grant.role} is deploy-capable: it is not a ` +
        `predefined role, and no permissions were supplied. Resolve the ` +
        `role's definition and ask again.`,
    );
  }

  return DEPLOY_PERMISSIONS.filter((verb) => granted.includes(verb));
};

/** Does this grant let its holder deploy? See `deployPermissionsGranted`. */
export const isDeployCapable = (grant: RoleGrant): boolean =>
  deployPermissionsGranted(grant).length > 0;
