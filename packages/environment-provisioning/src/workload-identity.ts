import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";

/**
 * EP-03: CI authenticates by Workload Identity Federation. Per-service pool
 * and provider, in the service's own production project — with a shared pool,
 * one permissive attribute condition exposes every service's production; with
 * a per-service pool the same mistake exposes one service, and it is the
 * service whose team made it. Blast radius follows ownership.
 *
 * No service account key is ever created, and the args expose no way to ask
 * for one — the same guarantee as SA-01. The bypass layer (a raw
 * `gcp.serviceaccount.Key` in a bootstrap stack) is caught by the
 * `ep03-no-service-account-keys` policy rule.
 *
 * Operational note, recorded rather than discovered: GCP soft-deletes pools
 * and providers and reserves the id for ~30 days, so re-bootstrapping a
 * torn-down service fails ALREADY_EXISTS. Detecting that and offering
 * `undelete` is the bootstrap command's job (E6) — a component cannot see it
 * offline.
 */

export interface WorkloadIdentityArgs {
  /** Service this identity deploys, e.g. "checkout". Derives the pool id. */
  readonly service: string;

  /** The production project the pool, provider and deployer live in. */
  readonly project: string;

  /**
   * The one GitHub repository allowed to mint this identity, as "org/repo".
   * Exactly one — no wildcard. A glob here is the shared-pool mistake with
   * extra steps.
   */
  readonly repository: string;

  /**
   * The one ref allowed to deploy production, e.g. "refs/heads/main".
   *
   * A single trailing `*` names a prefix — "refs/tags/v*" — because
   * release-path deploys production from pushed version tags. Still one
   * repository and one named ref shape, never the issuer at large.
   */
  readonly ref: string;
}

/** The GitHub OIDC issuer. The only identity provider this module federates. */
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

/**
 * Builds the provider's attribute condition. Exactly two grammars, and
 * `attributeConditionAdmits` evaluates exactly these two — the pair is what
 * lets the tests failure-inject both axes against the real emitted string.
 */
export const buildAttributeCondition = (repository: string, ref: string): string => {
  const repo = `assertion.repository == '${repository}'`;
  return ref.endsWith("*")
    ? `${repo} && assertion.ref.startsWith('${ref.slice(0, -1)}')`
    : `${repo} && assertion.ref == '${ref}'`;
};

/**
 * Evaluates a condition this module wrote against a token's claims.
 *
 * A deliberate mini-interpreter of the two grammars above, not CEL: handed
 * anything else — including a condition that matches everything — it throws
 * rather than guessing in either direction. Used by the tests to prove the
 * condition rejects a wrong repository and a wrong ref, and available to the
 * integration tier to cross-check what GCP was actually given.
 */
export const attributeConditionAdmits = (
  condition: string,
  claims: { readonly repository: string; readonly ref: string },
): boolean => {
  const match = condition.match(
    /^assertion\.repository == '([^']+)' && (?:assertion\.ref == '([^']+)'|assertion\.ref\.startsWith\('([^']+)'\))$/,
  );
  if (match === null) {
    throw new Error(
      `Not a condition this module writes: "${condition}". Refusing to guess ` +
        `what it admits.`,
    );
  }
  const [, repository, exactRef, refPrefix] = match;
  if (claims.repository !== repository) return false;
  return exactRef !== undefined
    ? claims.ref === exactRef
    : claims.ref.startsWith(refPrefix);
};

/**
 * The federated deploy identity for one service's production environment:
 * pool, provider, deployer service account, and the binding that lets the
 * named repository's workflows impersonate the deployer. What roles the
 * deployer holds is the composing environment's decision (E5), not this
 * component's.
 */
export class WorkloadIdentity extends pulumi.ComponentResource {
  public readonly pool: gcp.iam.WorkloadIdentityPool;
  public readonly provider: gcp.iam.WorkloadIdentityPoolProvider;
  public readonly deployer: gcp.serviceaccount.Account;

  /** The deployer's email, for the composing environment's grants. */
  public readonly deployerEmail: pulumi.Output<string>;

  /** The federated principal set the binding names. */
  public readonly principal: pulumi.Output<string>;

  constructor(
    name: string,
    args: WorkloadIdentityArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(args.repository)) {
      throw new Error(
        `WorkloadIdentity: repository must name exactly one GitHub repository ` +
          `as "org/repo" — got "${args.repository}". No wildcards: an unscoped ` +
          `pool lets any repository deploy this service's production.`,
      );
    }
    if (args.ref.indexOf("*") !== -1 && !args.ref.endsWith("*")) {
      throw new Error(
        `WorkloadIdentity: ref may end with a single '*' to name a prefix ` +
          `("refs/tags/v*"), nothing more — got "${args.ref}".`,
      );
    }

    super("runway:environment:WorkloadIdentity", name, {}, opts);

    this.pool = new gcp.iam.WorkloadIdentityPool(
      `${name}-pool`,
      {
        workloadIdentityPoolId: `${args.service}-github`,
        project: args.project,
        description: `GitHub federation for ${args.repository}, ${args.ref}`,
      },
      { parent: this },
    );

    this.provider = new gcp.iam.WorkloadIdentityPoolProvider(
      `${name}-provider`,
      {
        workloadIdentityPoolId: this.pool.workloadIdentityPoolId,
        workloadIdentityPoolProviderId: "github",
        project: args.project,
        oidc: { issuerUri: GITHUB_ISSUER },
        attributeMapping: {
          "google.subject": "assertion.sub",
          "attribute.repository": "assertion.repository",
          "attribute.ref": "assertion.ref",
        },
        // The control. Repository alone is insufficient — a fork's pull
        // request runs in the repository's context; the ref pins which one.
        attributeCondition: buildAttributeCondition(args.repository, args.ref),
      },
      { parent: this },
    );

    this.deployer = new gcp.serviceaccount.Account(
      `${name}-deployer`,
      {
        accountId: `${args.service}-deployer`,
        project: args.project,
        displayName: `CI deployer for ${args.service} production`,
      },
      { parent: this },
    );
    this.deployerEmail = this.deployer.email;

    this.principal = pulumi.interpolate`principalSet://iam.googleapis.com/${this.pool.name}/attribute.repository/${args.repository}`;

    // The one binding: the named repository's workflows may impersonate the
    // deployer, and nothing else may. Provider-level ref pinning plus this
    // repository-scoped member are the two halves of EP-02's scope.
    const binding = new gcp.serviceaccount.IAMMember(
      `${name}-binding`,
      {
        serviceAccountId: this.deployer.name,
        role: "roles/iam.workloadIdentityUser",
        member: this.principal,
      },
      { parent: this },
    );

    this.registerOutputs({
      pool: this.pool,
      provider: this.provider,
      deployer: this.deployer,
      deployerEmail: this.deployerEmail,
      principal: this.principal,
      binding,
    });
  }
}
