import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { TYPE_NAMESPACE } from "../type-namespace";
import { assertUserManagedServiceAccount } from "./service-account-email";

/** Arguments for {@link SecureContainerService}. */
export interface SecureContainerServiceArgs {
  /** Region, e.g. `"europe-west1"`. */
  readonly location: pulumi.Input<string>;

  /** Fully-qualified image reference. Digest-pinned in production. */
  readonly image: pulumi.Input<string>;

  /**
   * Runtime identity. Must be a user-managed service account
   * (`<id>@<project>.iam.gserviceaccount.com`); Google-managed default
   * identities are rejected. Control CR-04.
   *
   * A plain string is checked immediately. An `Output` can only be checked once
   * it resolves, so that failure surfaces during `pulumi preview` instead.
   */
  readonly serviceAccountEmail: pulumi.Input<string>;

  /**
   * Allow `pulumi destroy` to delete this service. Opt-out from the hardened
   * default, in the justified form: the reason is required, so every instance
   * is visible in code review and greppable across consuming repos.
   *
   * @default true (protected)
   */
  readonly deletionProtection?: true | { readonly disableJustification: string };
}

/**
 * A Cloud Run service that is private by default.
 *
 * Built from the three required arguments alone, it restricts ingress to an
 * internal load balancer, disables default-URI resolution, enables deletion
 * protection, emits no invoker IAM binding, and runs under the supplied
 * user-managed service account.
 *
 * **A default-constructed service is not reachable, and that is deliberate.**
 * Ingress is limited to an internal load balancer and v1 has no networking
 * module, so nothing routes to it until the consumer puts a load balancer in
 * front. That is the secure default working as intended — not a
 * misconfiguration to be "fixed" by reaching for a public opt-out.
 */
export class SecureContainerService extends pulumi.ComponentResource {
  /** The underlying Cloud Run service. */
  public readonly service: gcp.cloudrunv2.Service;

  /**
   * The service URI.
   *
   * On the private path `defaultUriDisabled` is `true`, so this value exists but
   * is **not publicly resolvable**. Reaching the service needs a load balancer.
   */
  public readonly uri: pulumi.Output<string>;

  /** Whether this service is exposed to the public internet. */
  public readonly isPublic: boolean;

  constructor(
    name: string,
    args: SecureContainerServiceArgs,
    opts?: pulumi.ComponentResourceOptions,
  ) {
    super(`${TYPE_NAMESPACE}:SecureContainerService`, name, {}, opts);

    // Fast path: a literal is the common case, and failing at the call site
    // beats failing several seconds into a preview.
    if (typeof args.serviceAccountEmail === "string") {
      assertUserManagedServiceAccount(args.serviceAccountEmail);
    }

    // The real guarantee. Covers Outputs, whose value is unknown until resolved,
    // and re-checks literals at negligible cost. Keeping the argument typed as
    // `Input<string>` is what lets a future `SecureServiceAccount.email` be
    // passed here without a breaking change.
    const serviceAccount = pulumi.output(args.serviceAccountEmail).apply((email) => {
      assertUserManagedServiceAccount(email);
      return email;
    });

    this.isPublic = false;

    this.service = new gcp.cloudrunv2.Service(
      name,
      {
        location: args.location,
        ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
        defaultUriDisabled: true,
        deletionProtection: isDeletionProtected(args.deletionProtection),
        template: {
          serviceAccount,
          containers: [{ image: args.image }],
        },
      },
      { parent: this },
    );

    this.uri = this.service.uri;
    this.registerOutputs({ service: this.service, uri: this.uri });
  }
}

/**
 * Deletion protection is on unless the caller supplied the justified opt-out.
 *
 * The justification is not written to the resource: its value is that it exists
 * in the source, where review and `grep` can find it.
 */
const isDeletionProtected = (
  deletionProtection: SecureContainerServiceArgs["deletionProtection"],
): boolean => deletionProtection === undefined || deletionProtection === true;
