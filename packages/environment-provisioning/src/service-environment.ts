import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

/**
 * One environment of one service: an adopted project, its deploy IAM, and its
 * state bucket. The caller composes it twice — staging, then production —
 * because two instances of a reviewed component beat one component with an
 * `isProduction` branch, and the branch is where the boundary silently
 * softens.
 */

/** Humans deploy here: a developers group, never an individual (EP-04). */
export interface HumanDeployers {
  /** The group's email, with or without its `group:` prefix. */
  readonly group: string;
}

/**
 * Who may deploy to this environment.
 *
 * One arm today, deliberately: staging is deployed by humans, and production
 * accepts only a federated CI identity — an arm E4 and E5 add. Until then a
 * `production` environment is unconstructible, loudly, rather than
 * constructible with a softer boundary than it will have.
 */
export type DeployableBy = {
  readonly humans: HumanDeployers;
};

export interface ServiceEnvironmentArgs {
  /** Service this environment belongs to, e.g. "checkout". */
  readonly service: string;

  /**
   * Environment name. Part of every derived identity — the project id and
   * the state bucket — which is what makes two environments structurally
   * unable to share either (EP-05).
   */
  readonly environment: "staging" | "production";

  /** GCP location for the environment's state bucket, e.g. "europe-west1". */
  readonly location: pulumi.Input<string>;

  /** Who may deploy here. See `DeployableBy`. */
  readonly deployableBy: DeployableBy;
}

/**
 * The deployers group, validated and normalised to its IAM member form.
 *
 * A plain `string` rather than an `Input`, deliberately: EP-04 rejects an
 * individual **at construction**, and a value only known at apply time would
 * move that refusal to the middle of a deploy — after other resources have
 * begun changing.
 */
const groupMember = (group: string): string => {
  const bare = group.startsWith("group:") ? group.slice("group:".length) : group;
  if (bare.includes(":")) {
    throw new Error(
      `EP-04: staging deploys are granted to a developers group, never to an ` +
        `individual or a service account — got "${group}". Pass the group's ` +
        `email (with or without its group: prefix).`,
    );
  }
  return `group:${bare}`;
};

/**
 * An adopted environment. Adopted, never created: no code path in this
 * component (or this module) creates or deletes a GCP project.
 */
export class ServiceEnvironment extends pulumi.ComponentResource {
  /** The adopted project id, derived: `<service>-<environment>`. */
  public readonly project: pulumi.Output<string>;

  /** Where this environment's Pulumi state lives. Versioned; never shared. */
  public readonly stateBucket: gcp.storage.Bucket;

  /** The deploy grant to the deployers group (EP-04). */
  public readonly deployGrant: gcp.projects.IAMMember;

  /** The deployers' access to this environment's state, on the bucket only. */
  public readonly stateAccessGrant: gcp.storage.BucketIAMMember;

  constructor(
    name: string,
    args: ServiceEnvironmentArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    if (args.environment === "production") {
      throw new Error(
        `ServiceEnvironment: production has no human variant — building it ` +
          `deployable by people would leave EP-01 unenforced, and a developer ` +
          `could deploy to production by hand. Production deploys only by the ` +
          `federated CI identity, which E4/E5 introduce.`,
      );
    }
    const member = groupMember(args.deployableBy.humans.group);

    super("runway:environment:ServiceEnvironment", name, {}, opts);

    // Derived, not passed: the same rule runway-cli's stack configs compute
    // with. Neither module tells the other an identifier.
    const project = `${args.service}-${args.environment}`;
    this.project = pulumi.output(project);

    // EP-05. Versioned so state survives a bad write; uniform bucket-level
    // access so a stray object ACL cannot widen who reads it; public access
    // prevention enforced because Pulumi state contains resource ids, config
    // and sometimes secrets. The name embeds service and environment, which
    // is what makes sharing a bucket between environments impossible rather
    // than discouraged.
    this.stateBucket = new gcp.storage.Bucket(
      `${name}-state`,
      {
        name: `${project}-state`,
        project,
        location: args.location,
        versioning: { enabled: true },
        uniformBucketLevelAccess: true,
        publicAccessPrevention: "enforced",
      },
      { parent: this },
    );

    // EP-04. roles/run.developer, not run.admin: deploying is create and
    // update; rewriting the service's IAM is escalation, and nothing about
    // deploying to staging needs it.
    this.deployGrant = new gcp.projects.IAMMember(
      `${name}-deploy`,
      { project, role: "roles/run.developer", member },
      { parent: this },
    );

    // State access on the bucket, not project-wide: the deployers read and
    // write this environment's state and nothing else's.
    this.stateAccessGrant = new gcp.storage.BucketIAMMember(
      `${name}-state-access`,
      { bucket: this.stateBucket.name, role: "roles/storage.objectAdmin", member },
      { parent: this },
    );

    this.registerOutputs({
      project: this.project,
      stateBucket: this.stateBucket,
      deployGrant: this.deployGrant,
      stateAccessGrant: this.stateAccessGrant,
    });
  }
}
