import type { Report } from "./cloud-run-rules";

/**
 * Rules covering Artifact Registry misuse in raw `gcp.*` resources.
 *
 * `SecureArtifactRepository` sets these correctly and offers no way to unset
 * them. These rules cover the consumer who declares a repository by hand.
 */

/** The subset of repository inputs these rules read. */
export interface RepositoryProps {
  readonly format?: string;
  readonly mode?: string;
  readonly cleanupPolicyDryRun?: boolean;
  readonly dockerConfig?: { readonly immutableTags?: boolean };
  readonly vulnerabilityScanningConfig?: { readonly enablementConfig?: string };
  readonly cleanupPolicies?: readonly unknown[];
}

/**
 * AR-01 — a Docker repository must freeze its tags.
 *
 * Without this, `:v1` can be repointed after it was reviewed, and everything
 * downstream — including Binary Authorization — is reasoning about a name
 * rather than an artefact.
 *
 * Only Docker repositories are checked: `dockerConfig` is meaningless on a
 * Maven or npm repository, and firing there would be a false positive, which is
 * how a rule gets switched off.
 */
export const checkImmutableTags = (props: RepositoryProps, report: Report): void => {
  if (props.format?.toUpperCase() !== "DOCKER") {
    return;
  }
  if (props.dockerConfig?.immutableTags !== true) {
    report(
      "Docker repository does not set dockerConfig.immutableTags. A mutable " +
        "tag can be repointed after review, so an approved image reference " +
        "stops meaning an approved image. Set it, or use " +
        "SecureArtifactRepository, which offers no way to unset it.",
    );
  }
};

/** AR-02 — scanning must not be switched off. */
export const checkVulnerabilityScanning = (
  props: RepositoryProps,
  report: Report,
): void => {
  if (props.vulnerabilityScanningConfig?.enablementConfig === "DISABLED") {
    report(
      "Repository disables vulnerability scanning. Use INHERITED so the " +
        "project's setting applies; there is no supported reason to opt a " +
        "single repository out.",
    );
  }
};

/**
 * AR-03 — retention policies must actually delete.
 *
 * `cleanupPolicyDryRun` evaluates every policy and removes nothing. The
 * repository looks correctly configured and retains everything, which is worse
 * than having no policy: the configuration reads as a control.
 */
export const checkCleanupNotDryRun = (props: RepositoryProps, report: Report): void => {
  if (props.cleanupPolicyDryRun === true) {
    report(
      "Repository sets cleanupPolicyDryRun, which evaluates its cleanup " +
        "policies and deletes nothing. The retention configuration is then " +
        "decorative while appearing to be enforced.",
    );
  }
};
