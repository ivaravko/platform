/**
 * Public surface of `@runway/gcp-components`.
 *
 * Consumers import from here and never deep-import. Components are exported as
 * they are built.
 */

export { TYPE_NAMESPACE } from "./type-namespace";
export { assertUserManagedServiceAccount } from "./container-service/service-account-email";
export { assertGrantableRoles } from "./service-account/role-allowlist";
export {
  SecureServiceAccount,
  type SecureServiceAccountArgs,
} from "./service-account/secure-service-account";
export {
  SecureContainerService,
  type SecureContainerServiceArgs,
} from "./container-service/secure-container-service";
