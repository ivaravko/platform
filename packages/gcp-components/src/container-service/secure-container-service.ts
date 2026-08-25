import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { TYPE_NAMESPACE } from "../type-namespace";
import { PUBLIC_ACCESS_PREFIX } from "./public-access-marker";
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
   * Expose the service to the public internet. Opt-out from the hardened
   * default, in the justified form.
   *
   * Supplying it flips ingress to `INGRESS_TRAFFIC_ALL`, re-enables default-URI
   * resolution, emits an `allUsers` invoker binding, and records the
   * justification on the resource — so a public service is visible from
   * `gcloud` without reading any source. Controls CR-02, CR-03, CR-08.
   *
   * The justification must be non-empty. An empty string satisfies the type and
   * defeats the control, so it is rejected.
   *
   * @default false
   */
  readonly publicAccess?: false | { readonly justification: string };

  /**
   * Binary Authorization. Control CR-09.
   *
   * **Opt-in, deliberately.** `useDefault` fails every deployment in a project
   * that has no Binary Authorization policy configured, so it cannot be a
   * library default without blocking every consumer who has not set one up.
   * Omitted, no `binaryAuthorization` block is emitted at all.
   *
   * `breakglassJustification` is **not exposed**: it is the documented way to
   * bypass the policy this control exists to apply.
   *
   * Note the Cloud Run v2 API takes no attestor here — attestors are configured
   * on the policy, out of band. The resource either selects the project default
   * or names a policy by path.
   */
  readonly binaryAuthorization?:
    | { readonly useDefault: true }
    | { readonly policy: pulumi.Input<string> };

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

    const publicAccess = justifiedPublicAccess(args.publicAccess);
    this.isPublic = publicAccess !== undefined;

    this.service = new gcp.cloudrunv2.Service(
      name,
      {
        location: args.location,
        ingress: this.isPublic
          ? "INGRESS_TRAFFIC_ALL"
          : "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
        // Pointless to withhold on the public path: the service is reachable
        // anyway, and a disabled default URI only makes it harder to find.
        defaultUriDisabled: !this.isPublic,
        deletionProtection: isDeletionProtected(args.deletionProtection),
        // Passed straight through. The narrowed union is what keeps
        // breakglassJustification unreachable: there is no path from the public
        // args type to that field.
        binaryAuthorization: args.binaryAuthorization,
        // Free text, so the reason survives verbatim. A label cannot hold it:
        // GCP label values allow only lowercase alphanumerics, "-" and "_", max
        // 63 characters, so any real sentence is rejected by the API.
        description:
          publicAccess === undefined
            ? undefined
            : `${PUBLIC_ACCESS_PREFIX}${publicAccess.justification}`,
        // Label-safe marker. Carries no reason — its job is to make every public
        // service in a project findable with `gcloud run services list --filter`.
        labels: publicAccess === undefined ? undefined : { [PUBLIC_LABEL]: "true" },
        template: {
          serviceAccount,
          containers: [{ image: args.image }],
        },
      },
      { parent: this },
    );

    // Never emitted implicitly. The binding exists only where a justification
    // was supplied, which is what CR-03 asserts in both directions.
    const invoker =
      publicAccess === undefined
        ? undefined
        : new gcp.cloudrunv2.ServiceIamMember(
            `${name}-invoker`,
            {
              location: args.location,
              name: this.service.name,
              role: "roles/run.invoker",
              member: "allUsers",
            },
            { parent: this },
          );

    this.uri = this.service.uri;
    this.registerOutputs({ service: this.service, uri: this.uri, invoker });
  }
}

/** Label key marking a publicly-reachable service. */
const PUBLIC_LABEL = "runway-public";

/**
 * Normalises the public-access opt-out, rejecting a justification that is
 * present but says nothing.
 *
 * `{ justification: "" }` type-checks and would otherwise buy public exposure at
 * no cost, which is exactly what the justified form exists to prevent.
 */
const justifiedPublicAccess = (
  publicAccess: SecureContainerServiceArgs["publicAccess"],
): { readonly justification: string } | undefined => {
  if (publicAccess === undefined || publicAccess === false) {
    return undefined;
  }
  if (publicAccess.justification.trim() === "") {
    throw new Error(
      "publicAccess.justification must say why this service is exposed to the " +
        "internet. It is recorded on the service and read during audit, so an " +
        "empty justification defeats the control it is part of.",
    );
  }
  return publicAccess;
};

/**
 * Deletion protection is on unless the caller supplied the justified opt-out.
 *
 * The justification is not written to the resource: its value is that it exists
 * in the source, where review and `grep` can find it.
 */
const isDeletionProtected = (
  deletionProtection: SecureContainerServiceArgs["deletionProtection"],
): boolean => deletionProtection === undefined || deletionProtection === true;
