import { PUBLIC_ACCESS_PREFIX } from "../container-service/public-access-marker";
import { isUserManagedServiceAccount } from "../container-service/service-account-email";

/**
 * Rules for the CrossGuard policy pack.
 *
 * These exist for the bypass case: a consumer who declares a raw `gcp.*`
 * resource and skips the components entirely. Constructor defaults and mocked
 * unit tests cannot see that consumer at all.
 *
 * Every rule is a plain function over plain props, deliberately. Reaching them
 * only through a running `pulumi preview` would make the rules themselves
 * untestable offline, and the alternative — weakening a rule so it could be
 * tested — is explicitly forbidden.
 *
 * **No rule keys on the `runway-public` label.** A label is a self-asserted
 * claim: the raw-resource author these rules exist to catch can set it in two
 * seconds. Rules key on what actually makes a service public — `ingress: ALL`,
 * an `allUsers` invoker binding — because those cannot be stripped to evade a
 * rule without making the service private, which is the outcome we want.
 */

/** Report callback, matching `@pulumi/policy`'s `ReportViolation`. */
export type Report = (message: string, urn?: string) => void;

/** The subset of Cloud Run service inputs these rules read. */
export interface ServiceProps {
  readonly ingress?: string;
  readonly description?: string;
  readonly invokerIamDisabled?: boolean;
  readonly deletionProtection?: boolean;
  readonly defaultUriDisabled?: boolean;
  readonly labels?: Record<string, string>;
  readonly name?: string;
  readonly location?: string;
  readonly binaryAuthorization?: {
    readonly useDefault?: boolean;
    readonly policy?: string;
    readonly breakglassJustification?: string;
  };
  readonly template?: { readonly serviceAccount?: string };
}

/** A stack resource, matching `@pulumi/policy`'s `PolicyResource`. */
export interface PolicyResourceLike {
  readonly type: string;
  readonly name: string;
  readonly props: Record<string, unknown>;
  /** Resources this one depends on. Populated by the engine, not by mocks. */
  readonly dependencies?: readonly PolicyResourceLike[];
  /** Per-property dependencies — the precise link from a binding to its service. */
  readonly propertyDependencies?: Record<string, readonly PolicyResourceLike[] | undefined>;
}

/**
 * Narrows an unknown prop to a string.
 *
 * `PolicyResource.props` is `Record<string, unknown>` because it holds whatever
 * a raw resource declared. A cast would assert a shape these rules exist to
 * doubt; this checks it.
 */
const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const SERVICE_TYPE = "gcp:cloudrunv2/service:Service";
const IAM_MEMBER_TYPE = "gcp:cloudrunv2/serviceIamMember:ServiceIamMember";
const PUBLIC_MEMBERS = new Set(["allUsers", "allAuthenticatedUsers"]);
const INVOKER_ROLE = "roles/run.invoker";

/**
 * Whether a description carries a real justification.
 *
 * The prefix alone is not enough: `"Public access justified:   "` satisfies a
 * naive check while saying nothing, which is the same hole the component's own
 * empty-justification guard closes.
 */
export const hasJustification = (description: string | undefined): boolean =>
  description !== undefined &&
  description.startsWith(PUBLIC_ACCESS_PREFIX) &&
  description.slice(PUBLIC_ACCESS_PREFIX.length).trim() !== "";

/** CR-01, CR-03 — public ingress requires a recorded justification. */
export const checkServiceIngress = (props: ServiceProps, report: Report): void => {
  if (props.ingress === "INGRESS_TRAFFIC_ALL" && !hasJustification(props.description)) {
    report(
      "Cloud Run service is exposed to the internet (ingress INGRESS_TRAFFIC_ALL) with no " +
        `justification recorded. Set description to "${PUBLIC_ACCESS_PREFIX}<reason>", or use ` +
        "SecureContainerService with publicAccess, which records it for you. A runway-public " +
        "label is not accepted as evidence.",
    );
  }
};

/** CR-05 — `invokerIamDisabled` removes the IAM check on invoke entirely. */
export const checkInvokerIamDisabled = (props: ServiceProps, report: Report): void => {
  if (props.invokerIamDisabled === true) {
    report(
      "Cloud Run service sets invokerIamDisabled, which disables the IAM permission check on " +
        "run.routes.invoke. That is broader than an allUsers binding and invisible in an IAM " +
        "policy dump. There is no supported justification for it.",
    );
  }
};

/** CR-04 — a user-managed runtime identity is required. */
export const checkRuntimeServiceAccount = (props: ServiceProps, report: Report): void => {
  const serviceAccount = props.template?.serviceAccount;

  if (serviceAccount === undefined || serviceAccount === "") {
    report(
      "Cloud Run service does not set template.serviceAccount. The field is optional in the " +
        "API, so omitting it silently runs the service as the default Compute Engine service " +
        "account, which carries broad project-level roles. Set a dedicated service account.",
    );
    return;
  }

  if (!isUserManagedServiceAccount(serviceAccount)) {
    report(
      `Cloud Run service runs as "${serviceAccount}", which is not a user-managed service ` +
        "account (<id>@<project>.iam.gserviceaccount.com). Create a dedicated service account " +
        "and grant it only the roles this service needs.",
    );
  }
};

/** CR-09 — breakglass bypasses Binary Authorization by design. */
export const checkBinaryAuthorization = (props: ServiceProps, report: Report): void => {
  if (props.binaryAuthorization?.breakglassJustification !== undefined) {
    report(
      "Cloud Run service sets binaryAuthorization.breakglassJustification, which bypasses the " +
        "Binary Authorization policy. Remove it and fix the attestation instead.",
    );
  }
};

/**
 * CR-03 — an `allUsers` invoker binding requires a justification on its service.
 *
 * A stack-level rule out of necessity: a policy on the IAM member sees only its
 * own props, and the justification lives on the service it points at. Resource
 * scope simply cannot answer this question.
 */
export const checkPublicInvokerBindings = (
  resources: readonly PolicyResourceLike[],
  report: Report,
): void => {
  const services = resources.filter((r) => r.type === SERVICE_TYPE);

  for (const resource of resources) {
    if (resource.type !== IAM_MEMBER_TYPE) {
      continue;
    }
    const member = asString(resource.props.member);
    const role = asString(resource.props.role);
    if (member === undefined || !PUBLIC_MEMBERS.has(member) || role !== INVOKER_ROLE) {
      continue;
    }

    if (!boundServiceIsJustified(resource, services)) {
      const target = asString(resource.props.name) ?? "(unknown)";
      report(
        `IAM binding grants ${member} the ${INVOKER_ROLE} role on Cloud Run service ` +
          `"${target}", which records no justification. Set the service's ` +
          `description to "${PUBLIC_ACCESS_PREFIX}<reason>", or use SecureContainerService ` +
          "with publicAccess.",
      );
    }
  }
};

/**
 * Whether the service a binding points at records a justification.
 *
 * Resolution is by dependency edge first and name second, because a Cloud Run
 * service's `name` is usually **provider-generated**: it is an output, not an
 * input, so a stack that lets Pulumi auto-name its services has nothing to match
 * on. The engine does record that the binding's `name` property depends on the
 * service resource, and that edge survives auto-naming.
 *
 * Unresolvable means unjustified. Failing open would make the rule evadable by
 * simply not wiring the reference.
 */
const boundServiceIsJustified = (
  binding: PolicyResourceLike,
  services: readonly PolicyResourceLike[],
): boolean => {
  const linked = [
    ...(binding.propertyDependencies?.name ?? []),
    ...(binding.dependencies ?? []),
  ].filter((r) => r.type === SERVICE_TYPE);

  if (linked.length > 0) {
    return linked.every((service) => hasJustification(asString(service.props.description)));
  }

  // Fallback: an explicitly-named service can still be matched by name.
  const target = asString(binding.props.name);
  if (target === undefined) {
    return false;
  }
  const byName = services.filter((s) => asString(s.props.name) === target);
  return byName.length > 0 && byName.every((s) => hasJustification(asString(s.props.description)));
};
