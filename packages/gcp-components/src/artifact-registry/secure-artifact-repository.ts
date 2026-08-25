import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { TYPE_NAMESPACE } from "../type-namespace";

/** Thirty days, in the seconds form the Artifact Registry API accepts. */
const THIRTY_DAYS = "2592000s";

/** How many recent versions to retain unless the caller widens it. */
const DEFAULT_KEEP_MOST_RECENT = 10;

/** Arguments for {@link SecureArtifactRepository}. */
export interface SecureArtifactRepositoryArgs {
  /** Repository id — the last path segment of an image reference. */
  readonly repositoryId: pulumi.Input<string>;

  /** Region, e.g. `"europe-west1"`. */
  readonly location: pulumi.Input<string>;

  /** Project. Defaults to the provider's. */
  readonly project?: pulumi.Input<string>;

  /** What this repository holds. */
  readonly description?: pulumi.Input<string>;

  /**
   * Customer-managed encryption key. **Supported, not required** — there is no
   * KMS component until v2, so this is bring-your-own-key.
   */
  readonly kmsKeyName?: pulumi.Input<string>;

  /**
   * How many recent versions to keep. Widening retention is the caller's to
   * make; removing it is not, so there is no value that disables the policy.
   *
   * @default 10
   */
  readonly keepMostRecent?: number;
}

/**
 * A Docker repository whose tags cannot be repointed.
 *
 * **`immutableTags` is the control that makes review meaningful.** Without it,
 * `:v1` can be made to mean something else after it was approved, and every
 * downstream guarantee — including Binary Authorization — is reasoning about a
 * name rather than an artefact. There is no justified opt-out, so unlike
 * `publicAccess` there is no escape hatch at all.
 *
 * Note what the flag does *not* do: per the provider's own documentation it
 * "prevents all tags from being modified, moved or deleted. This does not
 * prevent tags from being created." New tags are still allowed; existing ones
 * are frozen.
 */
export class SecureArtifactRepository extends pulumi.ComponentResource {
  /** The underlying repository. */
  public readonly repository: gcp.artifactregistry.Repository;

  /** `<location>-docker.pkg.dev/<project>/<id>` — prepend to an image name. */
  public readonly imagePrefix: pulumi.Output<string>;

  constructor(
    name: string,
    args: SecureArtifactRepositoryArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super(`${TYPE_NAMESPACE}:SecureArtifactRepository`, name, {}, opts);

    const keepMostRecent = args.keepMostRecent ?? DEFAULT_KEEP_MOST_RECENT;
    if (!Number.isInteger(keepMostRecent) || keepMostRecent < 1) {
      throw new Error(
        `keepMostRecent must be a positive whole number of versions to keep, ` +
          `got ${String(keepMostRecent)}. Retention can be widened, not removed: ` +
          `a repository that keeps nothing cannot serve a rollback.`,
      );
    }

    this.repository = new gcp.artifactregistry.Repository(
      name,
      {
        repositoryId: args.repositoryId,
        location: args.location,
        project: args.project,
        description: args.description,
        format: "DOCKER",
        // Standard only. A remote repository proxies an external registry, so
        // images would arrive from somewhere the immutable-tag guarantee does
        // not reach.
        mode: "STANDARD_REPOSITORY",
        kmsKeyName: args.kmsKeyName,
        dockerConfig: { immutableTags: true },
        // INHERITED follows the project setting; DISABLED is the only other
        // value and is never what we want.
        vulnerabilityScanningConfig: { enablementConfig: "INHERITED" },
        // Left unset rather than false: dry-run evaluates the policies and
        // deletes nothing, so a repository would look correctly configured and
        // retain everything. AR-03 asserts it is not on.
        cleanupPolicies: [
          {
            id: "keep-most-recent",
            action: "KEEP",
            mostRecentVersions: { keepCount: keepMostRecent },
          },
          {
            id: "delete-untagged",
            action: "DELETE",
            condition: { tagState: "UNTAGGED", olderThan: THIRTY_DAYS },
          },
        ],
      },
      { parent: this },
    );

    this.imagePrefix = pulumi.interpolate`${this.repository.location}-docker.pkg.dev/${this.repository.project}/${this.repository.repositoryId}`;

    this.registerOutputs({
      repository: this.repository,
      imagePrefix: this.imagePrefix,
    });
  }
}
