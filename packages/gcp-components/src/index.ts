/**
 * Public surface of `@runway/gcp-components`.
 *
 * Consumers import from here and never deep-import. Components are exported as
 * they are built.
 */

export { assertUserManagedServiceAccount } from "./container-service/service-account-email";

/**
 * Pulumi type-string namespace for every component in this package.
 *
 * Components register as `runway:gcp:<Component>`, so this is the one place the
 * prefix is written down.
 */
export const TYPE_NAMESPACE = "runway:gcp";
