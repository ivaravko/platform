/**
 * Validation for a Cloud Run runtime service account. Control CR-04.
 *
 * The rule is **positive**: an address is accepted only if it matches the
 * user-managed service-account form. Every Google-managed default runtime
 * identity — Compute Engine, App Engine, Cloud Build — lives outside
 * `.iam.gserviceaccount.com` and is therefore rejected without being named.
 *
 * That direction matters. A denylist would need a new entry every time Google
 * introduces a default identity, and would silently pass the ones nobody had
 * added yet. The positive rule needs no maintenance.
 *
 * **What this does not claim.** Some Google-managed *service agents* do live
 * under `.iam.gserviceaccount.com` (for example
 * `service-<n>@gcf-admin-robot.iam.gserviceaccount.com`) and will pass. The
 * guarantee here is narrower than "never Google-managed": it is that the
 * over-privileged **default runtime identities** — the ones a service silently
 * falls back to, carrying broad project-level roles — cannot be used. A service
 * agent cannot be impersonated as a Cloud Run runtime identity anyway.
 */

/**
 * `<id>@<project>.iam.gserviceaccount.com`.
 *
 * The id part encodes GCP's own rule: 6–30 characters, starting with a letter
 * and ending alphanumeric, so a malformed id is refused here rather than by the
 * API several minutes into a deployment.
 */
const USER_MANAGED_SERVICE_ACCOUNT =
  /^[a-z][-a-z0-9]{4,28}[a-z0-9]@[a-z0-9-]+\.iam\.gserviceaccount\.com$/;

/**
 * Recognised default identities.
 *
 * **These are not the security boundary** — the positive rule above is. This
 * list exists only so the error can say *which* default was passed instead of
 * repeating the generic shape. Adding or removing an entry changes the message
 * and never changes what is accepted.
 */
const GOOGLE_MANAGED_DEFAULTS: readonly (readonly [RegExp, string])[] = [
  [/^\d+-compute@developer\.gserviceaccount\.com$/, "the default Compute Engine service account"],
  [/@appspot\.gserviceaccount\.com$/, "the default App Engine service account"],
  [/^\d+@cloudbuild\.gserviceaccount\.com$/, "the default Cloud Build service account"],
];

/** What to do about it. Every failure ends with this. */
const REMEDY =
  "Create a dedicated service account and grant it only the roles this service needs.";

/**
 * Whether `email` is a user-managed service account.
 *
 * The predicate behind {@link assertUserManagedServiceAccount}, exported so the
 * policy pack applies the identical rule to raw resources. Two implementations
 * of one control would drift, and the drift would be silent.
 */
export const isUserManagedServiceAccount = (email: string): boolean =>
  USER_MANAGED_SERVICE_ACCOUNT.test(email);

/**
 * Throws unless `email` is a user-managed service account.
 *
 * @param email The address to check.
 * @throws If the address is anything other than
 *   `<id>@<project>.iam.gserviceaccount.com`.
 */
export function assertUserManagedServiceAccount(email: string): void {
  if (isUserManagedServiceAccount(email)) {
    return;
  }

  const known = GOOGLE_MANAGED_DEFAULTS.find(([pattern]) => pattern.test(email));

  throw new Error(
    known === undefined
      ? `serviceAccountEmail must be a user-managed service account ` +
        `(<id>@<project>.iam.gserviceaccount.com), got "${email}". ${REMEDY}`
      : `serviceAccountEmail is ${known[1]}, which carries broad project-level ` +
        `roles. ${REMEDY}`,
  );
}
