import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { TYPE_NAMESPACE } from "../type-namespace";
import { assertGrantableRoles } from "./role-allowlist";

/** Arguments for {@link SecureServiceAccount}. */
export interface SecureServiceAccountArgs {
  /** Account id — the local part of the resulting email. */
  readonly accountId: pulumi.Input<string>;

  /** Project the account belongs to. Required if {@link roles} is non-empty. */
  readonly project?: pulumi.Input<string>;

  /** Human-readable name shown in the console. */
  readonly displayName?: pulumi.Input<string>;

  /** What this identity is for. */
  readonly description?: pulumi.Input<string>;

  /**
   * Project-level roles to grant. **Empty by default — nothing is granted
   * unless it is named here.** Control SA-02.
   *
   * A plain array rather than an `Input`, deliberately: the roles a service may
   * hold are a decision made when the code is written, not a value discovered
   * at deploy time. Keeping it plain makes SA-03's validation synchronous, and
   * therefore testable — the lesson from `SecureContainerService`, whose
   * `Input` argument produced a validation path that cannot be unit-tested.
   */
  readonly roles?: readonly string[];
}

/**
 * A dedicated service account that grants nothing by default.
 *
 * **User-managed keys are unreachable through this component.** There is no
 * argument, no method, and no escape hatch that produces a
 * `gcp.serviceaccount.Key`; Workload Identity is the only supported path, and
 * the policy pack rejects raw keys stack-wide for consumers who bypass this
 * class entirely. Control SA-01.
 */
export class SecureServiceAccount extends pulumi.ComponentResource {
  /** The underlying service account. */
  public readonly account: gcp.serviceaccount.Account;

  /** The account's email — what `SecureContainerService` consumes. */
  public readonly email: pulumi.Output<string>;

  /** The `serviceAccount:<email>` form, for IAM bindings. */
  public readonly member: pulumi.Output<string>;

  constructor(
    name: string,
    args: SecureServiceAccountArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super(`${TYPE_NAMESPACE}:SecureServiceAccount`, name, {}, opts);

    const roles = args.roles ?? [];
    assertGrantableRoles(roles);

    // Narrowed here rather than asserted at the binding: a guard TypeScript
    // cannot see is not a guard, and the linter is right to say so.
    const grantProject = roles.length === 0 ? undefined : requireProject(args.project);

    this.account = new gcp.serviceaccount.Account(
      name,
      {
        accountId: args.accountId,
        project: args.project,
        displayName: args.displayName,
        description: args.description,
      },
      { parent: this },
    );

    this.email = this.account.email;
    this.member = this.account.member;

    // One binding per requested role. Nothing is granted implicitly — SA-02
    // asserts both directions: none by default, and exactly these when asked.
    const bindings =
      grantProject === undefined
        ? []
        : roles.map(
            (role, index) =>
              new gcp.projects.IAMMember(
                `${name}-role-${String(index)}`,
                { project: grantProject, role, member: this.member },
                { parent: this },
              ),
          );

    this.registerOutputs({ account: this.account, email: this.email, bindings });
  }
}

/**
 * Returns the project, or explains why one is needed.
 *
 * Separate from the constructor so the caller gets a narrowed
 * `Input<string>` — the alternative was a type assertion, which claims the
 * guarantee instead of establishing it.
 */
const requireProject = (
  project: pulumi.Input<string> | undefined,
): pulumi.Input<string> => {
  if (project === undefined) {
    throw new Error(
      "A project is required to grant roles: an IAM binding names the project " +
        "it applies to. Pass `project`, or drop `roles` and grant them where " +
        "the resource that needs them is defined.",
    );
  }
  return project;
};
