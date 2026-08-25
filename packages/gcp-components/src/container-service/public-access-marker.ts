/**
 * Prefix written to a public service's `description`.
 *
 * Lives in its own module because two independent things depend on it agreeing:
 * the component that writes it, and the policy rules that read it as the
 * evidence public exposure was justified. A drift between them would not fail —
 * it would silently stop enforcing.
 */
export const PUBLIC_ACCESS_PREFIX = "Public access justified: ";
