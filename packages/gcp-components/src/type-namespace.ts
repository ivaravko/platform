/**
 * Pulumi type-string namespace for every component in this package.
 *
 * Components register as `runway:gcp:<Component>`. Kept in its own module
 * rather than in `index.ts`: components need it, `index.ts` re-exports the
 * components, and importing it from the barrel would close that loop.
 */
export const TYPE_NAMESPACE = "runway:gcp";
