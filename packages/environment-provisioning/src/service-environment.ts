import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { auditProductionPolicy, type IamPolicy } from "./audit";
import { WorkloadIdentity } from "./workload-identity";

/**
 * One environment of one service: an adopted project, its deploy IAM, and its
 * state bucket. The caller composes it twice — staging, then production —
 * because two instances of a reviewed component beat one component with an
 * `isProduction` branch, and the branch is where the boundary silently
 * softens.
 */

/** Humans deploy here: a developers group, never an individual (EP-04). */
export interface HumanDeployers {
  /**
   * The group's email, with or without its `group:` prefix.
   *
   * Optional, because an organisation may have no group yet — creating one
   * is a Workspace-admin action this module cannot take. **Absent means no
   * deploy grant is managed and EP-04 is not in force**, which `runway
   * bootstrap` reports on every run rather than leaving to be noticed. It
   * never means "grant an individual instead": a `user:` value is still
   * rejected, and there is no per-person variant to fall back to.
   */
  readonly group?: string;
}

/**
 * CI deploys here, by federation: the identity localhost does not have.
 *
 * No opt-out lives in this type, deliberately. Unlike `publicAccess` there
 * is no acceptable form of a human production deploy, so there is no field
 * to supply one through.
 */
export interface CiDeployer {
  /** The one GitHub repository allowed to deploy, as "org/repo". */
  readonly repository: string;

  /**
   * The refs allowed to mint the deploy identity — typically main (image
   * pushes) and the release tag prefix. Each exact or trailing-`*` prefix.
   */
  readonly refs: readonly string[];

  /**
   * The adopted project's **current** IAM policy, audited before a single
   * resource is built (EP-06). If it already grants a deploy-capable role to
   * a human, construction refuses with the audit's full message — bootstrap
   * fails rather than proceeding onto a compromised project.
   */
  readonly existingPolicy: IamPolicy;

  /** Resolved permissions for custom roles in `existingPolicy`, if any. */
  readonly customRolePermissions?: Readonly<Record<string, readonly string[]>>;

  /**
   * The project whose registry holds this service's images — staging, in the
   * paved-road layout: `main` pushes them there and a release resolves its
   * digest from there. When set, the deployer is granted
   * `roles/artifactregistry.writer` on that project, because one identity
   * does both jobs and the images live across the project boundary.
   *
   * Found by the first real bootstrap run, not by reading: without this, the
   * image push 403s the moment the repository variables move to the
   * production identity. Writer carries no deploy verb — the deploy
   * permission set proves it — so "staging is deployed by people" survives.
   */
  readonly imageProject?: string;
}

/**
 * Who may deploy to this environment.
 *
 * The discriminated union is the boundary: staging is deployed by people,
 * production only by the federated CI identity. There is no variant of this
 * type that grants a human deploy access to production — making that a type
 * error rather than a review comment is the point.
 */
export type DeployableBy =
  | { readonly humans: HumanDeployers }
  | { readonly ci: CiDeployer };

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

  /**
   * Staging only: a federated CI identity that may **publish images**, and
   * nothing more — `roles/artifactregistry.writer`, scoped to the one
   * repository's `refs/heads/main`. It holds no deploy verb, so "staging is
   * deployed by people" survives it, and the deploy permission set is what
   * proves writer is not deploy-capable. Production refuses this: its
   * deployer already publishes.
   */
  readonly ciImagePublisher?: { readonly repository: string };
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

  /**
   * The deploy grants: one role to the group for staging; the deployer SA's
   * role set for production. Always to exactly one principal per environment.
   */
  public readonly deployGrants: readonly gcp.projects.IAMMember[];

  /** The deployers' access to this environment's state, on the bucket only.
   * Absent exactly when no deployer principal exists to grant it to. */
  public readonly stateAccessGrant?: gcp.storage.BucketIAMMember;

  /** Production's federated identity (EP-02, EP-03). Absent for staging. */
  public readonly federation?: WorkloadIdentity;

  /** Staging's image-publisher federation, when configured. Never a deployer. */
  public readonly imagePublisher?: WorkloadIdentity;

  /** The publisher's one grant: registry writer, and nothing else. */
  public readonly imagePublisherGrant?: gcp.projects.IAMMember;

  /** Production's writer on the image project's registry. See `CiDeployer.imageProject`. */
  public readonly imageAccessGrant?: gcp.projects.IAMMember;

  constructor(
    name: string,
    args: ServiceEnvironmentArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    // The cross-checks, before any resource exists. The type steers; these
    // enforce — because a caller can arrive here through `any`, and the
    // boundary must not depend on the compiler having been consulted.
    if ("humans" in args.deployableBy && args.environment === "production") {
      throw new Error(
        `ServiceEnvironment: production has no human variant — building it ` +
          `deployable by people would leave EP-01 unenforced, and a developer ` +
          `could deploy to production by hand. Production deploys only by the ` +
          `federated CI identity.`,
      );
    }
    if (args.ciImagePublisher !== undefined && args.environment === "production") {
      throw new Error(
        `ServiceEnvironment: production takes no separate image publisher — ` +
          `its deployer already publishes, and a second identity would be a ` +
          `second thing to audit for no capability gained.`,
      );
    }
    if ("ci" in args.deployableBy && args.environment === "staging") {
      throw new Error(
        `ServiceEnvironment: staging is deployed by people, from their own ` +
          `credentials, so the audit log names a person (RP-04). A ` +
          `CI-deployed staging is a second identity model nothing specifies.`,
      );
    }

    const deployable = args.deployableBy;

    // Both refusals fire before any resource exists: the group validation
    // (EP-04), and EP-06's audit of the adopted project — refuse rather than
    // proceed onto a compromised project. The audit's message is the error;
    // it carries the whole decision.
    if ("humans" in deployable) {
      if (deployable.humans.group !== undefined) {
        groupMember(deployable.humans.group);
      }
    } else {
      const audit = auditProductionPolicy({
        projectId: `${args.service}-${args.environment}`,
        policy: deployable.ci.existingPolicy,
        customRolePermissions: deployable.ci.customRolePermissions,
      });
      if (!audit.compliant) {
        throw new Error(audit.refusal);
      }
    }

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

    let deployMember: pulumi.Input<string> | undefined;
    let deployRoles: readonly string[];
    if ("humans" in deployable) {
      // EP-04. roles/run.developer, not run.admin: deploying is create and
      // update; rewriting the service's IAM is escalation, and nothing about
      // deploying to staging needs it. No group yet means no grant at all —
      // never an individual.
      deployMember =
        deployable.humans.group === undefined
          ? undefined
          : groupMember(deployable.humans.group);
      deployRoles = ["roles/run.developer"];
    } else {
      const ci = deployable.ci;

      // EP-02, EP-03: the federated identity, composed here so production
      // cannot exist without it.
      this.federation = new WorkloadIdentity(
        `${name}-wif`,
        {
          service: args.service,
          project,
          repository: ci.repository,
          refs: ci.refs,
        },
        { parent: this },
      );

      // The CI deploy runs the whole infra program, so the deployer needs
      // what the program manages, not only run.services.*: the artifact
      // registry it creates and pushes into, the runtime service account it
      // creates and acts as, and the service IAM SecureContainerService
      // manages (invoker bindings on a justified public service). Every role
      // goes to the one federated identity — a person never holds any of
      // them; that is EP-01, enforced above and audited before it.
      deployMember = pulumi.interpolate`serviceAccount:${this.federation.deployerEmail}`;
      deployRoles = [
        "roles/run.admin",
        "roles/artifactregistry.admin",
        "roles/iam.serviceAccountAdmin",
        "roles/iam.serviceAccountUser",
      ];
    }

    const member = deployMember;
    this.deployGrants =
      member === undefined
        ? []
        : deployRoles.map(
            (role, index) =>
              new gcp.projects.IAMMember(
                index === 0 ? `${name}-deploy` : `${name}-deploy-${String(index)}`,
                { project, role, member },
                { parent: this },
              ),
          );

    // One identity, both jobs: main pushes images, tags promote them — and
    // the images live in another project's registry, so the writer grant has
    // to cross the boundary with the identity.
    const imageProject =
      "ci" in args.deployableBy ? args.deployableBy.ci.imageProject : undefined;
    this.imageAccessGrant =
      imageProject === undefined || member === undefined
        ? undefined
        : new gcp.projects.IAMMember(
            `${name}-image-access`,
            { project: imageProject, role: "roles/artifactregistry.writer", member },
            { parent: this },
          );

    // State access on the bucket, not project-wide: the deployers read and
    // write this environment's state and nothing else's.
    this.stateAccessGrant =
      member === undefined
        ? undefined
        : new gcp.storage.BucketIAMMember(
            `${name}-state-access`,
            {
              bucket: this.stateBucket.name,
              role: "roles/storage.objectAdmin",
              member,
            },
            { parent: this },
          );

    if (args.ciImagePublisher !== undefined) {
      this.imagePublisher = new WorkloadIdentity(
        `${name}-publisher`,
        {
          service: args.service,
          project,
          repository: args.ciImagePublisher.repository,
          // Images are built from main and only main; releases are the
          // production deployer's refs, not this identity's.
          refs: ["refs/heads/main"],
        },
        { parent: this },
      );
      this.imagePublisherGrant = new gcp.projects.IAMMember(
        `${name}-publisher-writer`,
        {
          project,
          role: "roles/artifactregistry.writer",
          member: pulumi.interpolate`serviceAccount:${this.imagePublisher.deployerEmail}`,
        },
        { parent: this },
      );
    }

    this.registerOutputs({
      project: this.project,
      stateBucket: this.stateBucket,
      deployGrants: this.deployGrants,
      stateAccessGrant: this.stateAccessGrant,
      federation: this.federation,
      imagePublisher: this.imagePublisher,
      imagePublisherGrant: this.imagePublisherGrant,
      imageAccessGrant: this.imageAccessGrant,
    });
  }
}
