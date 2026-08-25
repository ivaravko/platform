import { describe, expect, it, vi } from "vitest";
import {
  checkBinaryAuthorization,
  checkInvokerIamDisabled,
  checkPublicInvokerBindings,
  checkRuntimeServiceAccount,
  checkServiceIngress,
  type PolicyResourceLike,
  type ServiceProps,
} from "../../src/policy/cloud-run-rules";

/**
 * The bypass layer: a consumer who declares a raw `gcp.*` resource and skips the
 * components entirely. Constructor defaults and unit assertions cannot see them.
 *
 * Rules are plain functions taking props and a report callback, so they test
 * with a spy and no stack, no engine and no credentials. That was C7's stated
 * stop condition — had the rules only been reachable through a running
 * `pulumi preview`, the task said to stop and report rather than weaken them.
 */

const SA = "api-runtime@my-proj.iam.gserviceaccount.com";
const JUSTIFIED = "Public access justified: handles public webhooks from Stripe";

const compliant = (): ServiceProps => ({
  ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
  deletionProtection: true,
  defaultUriDisabled: true,
  template: { serviceAccount: SA },
});

const report = () => vi.fn<(message: string, urn?: string) => void>();

describe("CR-01/CR-03: public ingress requires a recorded justification", () => {
  it("passes a private service", () => {
    const r = report();
    checkServiceIngress(compliant(), r);
    expect(r).not.toHaveBeenCalled();
  });

  it("rejects ingress ALL with no description", () => {
    const r = report();
    checkServiceIngress({ ...compliant(), ingress: "INGRESS_TRAFFIC_ALL" }, r);
    expect(r).toHaveBeenCalledOnce();
  });

  it("rejects ingress ALL with an unjustified description", () => {
    const r = report();
    checkServiceIngress(
      { ...compliant(), ingress: "INGRESS_TRAFFIC_ALL", description: "the api" },
      r,
    );
    expect(r).toHaveBeenCalledOnce();
  });

  it("rejects a justification prefix with nothing after it", () => {
    const r = report();
    checkServiceIngress(
      { ...compliant(), ingress: "INGRESS_TRAFFIC_ALL", description: "Public access justified:   " },
      r,
    );
    expect(r).toHaveBeenCalledOnce();
  });

  it("passes ingress ALL when a justification is recorded", () => {
    const r = report();
    checkServiceIngress({ ...compliant(), ingress: "INGRESS_TRAFFIC_ALL", description: JUSTIFIED }, r);
    expect(r).not.toHaveBeenCalled();
  });

  it("OQ2: a forged runway-public label buys nothing without a justification", () => {
    // The bypass this rule was redesigned to close. A label is a self-asserted
    // claim; keying on it would let a hand-written raw resource pass by typing
    // two words.
    const r = report();
    checkServiceIngress(
      {
        ...compliant(),
        ingress: "INGRESS_TRAFFIC_ALL",
        labels: { "runway-public": "true" },
      },
      r,
    );
    expect(r).toHaveBeenCalledOnce();
  });
});

describe("CR-05: invokerIamDisabled is never acceptable", () => {
  it("passes when unset", () => {
    const r = report();
    checkInvokerIamDisabled(compliant(), r);
    expect(r).not.toHaveBeenCalled();
  });

  it("rejects it when true", () => {
    const r = report();
    checkInvokerIamDisabled({ ...compliant(), invokerIamDisabled: true }, r);
    expect(r).toHaveBeenCalledOnce();
  });
});

describe("CR-04: runtime service account", () => {
  it("passes a user-managed service account", () => {
    const r = report();
    checkRuntimeServiceAccount(compliant(), r);
    expect(r).not.toHaveBeenCalled();
  });

  it("rejects an absent serviceAccount, which silently means the default compute SA", () => {
    // The API types template.serviceAccount as optional, so omitting it is legal
    // and yields the default compute identity. This rule is the only thing
    // between a raw resource and that outcome.
    const r = report();
    checkRuntimeServiceAccount({ ...compliant(), template: {} }, r);
    expect(r).toHaveBeenCalledOnce();
  });

  it("rejects an absent template entirely", () => {
    const r = report();
    checkRuntimeServiceAccount({ ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" }, r);
    expect(r).toHaveBeenCalledOnce();
  });

  it.each([
    ["default compute", "123456789-compute@developer.gserviceaccount.com"],
    ["App Engine default", "my-proj@appspot.gserviceaccount.com"],
    ["a human", "dev@example.com"],
  ])("rejects the %s identity", (_label, serviceAccount) => {
    const r = report();
    checkRuntimeServiceAccount({ ...compliant(), template: { serviceAccount } }, r);
    expect(r).toHaveBeenCalledOnce();
  });
});

describe("CR-09: breakglass is never acceptable", () => {
  it("passes when binaryAuthorization is absent", () => {
    const r = report();
    checkBinaryAuthorization(compliant(), r);
    expect(r).not.toHaveBeenCalled();
  });

  it("passes a policy selection with no breakglass", () => {
    const r = report();
    checkBinaryAuthorization({ ...compliant(), binaryAuthorization: { useDefault: true } }, r);
    expect(r).not.toHaveBeenCalled();
  });

  it("rejects any breakglassJustification", () => {
    const r = report();
    checkBinaryAuthorization(
      { ...compliant(), binaryAuthorization: { breakglassJustification: "shipping now" } },
      r,
    );
    expect(r).toHaveBeenCalledOnce();
  });
});

describe("CR-03: allUsers invoker bindings, correlated across the stack", () => {
  const SERVICE = "gcp:cloudrunv2/service:Service";
  const MEMBER = "gcp:cloudrunv2/serviceIamMember:ServiceIamMember";

  const stack = (description?: string, member = "allUsers"): PolicyResourceLike[] => [
    {
      type: SERVICE,
      name: "api",
      props: { ...compliant(), ingress: "INGRESS_TRAFFIC_ALL", name: "api", description },
    },
    { type: MEMBER, name: "api-invoker", props: { name: "api", member, role: "roles/run.invoker" } },
  ];

  it("passes when the bound service records a justification", () => {
    const r = report();
    checkPublicInvokerBindings(stack(JUSTIFIED), r);
    expect(r).not.toHaveBeenCalled();
  });

  it.each([["allUsers"], ["allAuthenticatedUsers"]])(
    "rejects a %s binding when the service records none",
    (member) => {
      const r = report();
      checkPublicInvokerBindings(stack(undefined, member), r);
      expect(r).toHaveBeenCalledOnce();
    },
  );

  it("ignores bindings to a specific principal", () => {
    const r = report();
    checkPublicInvokerBindings(stack(undefined, "serviceAccount:ci@p.iam.gserviceaccount.com"), r);
    expect(r).not.toHaveBeenCalled();
  });

  it("rejects an allUsers binding whose target service is not in the stack", () => {
    // Cannot prove a justification exists, so it cannot be assumed.
    const r = report();
    checkPublicInvokerBindings(
      [{ type: MEMBER, name: "orphan", props: { name: "elsewhere", member: "allUsers", role: "roles/run.invoker" } }],
      r,
    );
    expect(r).toHaveBeenCalledOnce();
  });
});

describe("CR-03: binding-to-service resolution", () => {
  const SERVICE = "gcp:cloudrunv2/service:Service";
  const MEMBER = "gcp:cloudrunv2/serviceIamMember:ServiceIamMember";

  const service = (description?: string): PolicyResourceLike => ({
    type: SERVICE,
    name: "api",
    // No props.name: Cloud Run service names are provider-generated, so a stack
    // that lets Pulumi auto-name has nothing to match on. This is the common case.
    props: { ingress: "INGRESS_TRAFFIC_ALL", description },
  });

  it("resolves through propertyDependencies when the service is auto-named", () => {
    const target = service(JUSTIFIED);
    const r = report();
    checkPublicInvokerBindings(
      [
        target,
        {
          type: MEMBER,
          name: "api-invoker",
          props: { member: "allUsers", role: "roles/run.invoker" },
          propertyDependencies: { name: [target] },
        },
      ],
      r,
    );
    expect(r).not.toHaveBeenCalled();
  });

  it("reports through propertyDependencies when the linked service is unjustified", () => {
    const target = service(undefined);
    const r = report();
    checkPublicInvokerBindings(
      [
        target,
        {
          type: MEMBER,
          name: "api-invoker",
          props: { member: "allUsers", role: "roles/run.invoker" },
          propertyDependencies: { name: [target] },
        },
      ],
      r,
    );
    expect(r).toHaveBeenCalledOnce();
  });

  it("resolves through the generic dependencies list too", () => {
    const target = service(JUSTIFIED);
    const r = report();
    checkPublicInvokerBindings(
      [
        target,
        {
          type: MEMBER,
          name: "api-invoker",
          props: { member: "allUsers", role: "roles/run.invoker" },
          dependencies: [target],
        },
      ],
      r,
    );
    expect(r).not.toHaveBeenCalled();
  });

  it("fails closed when nothing links the binding to a service", () => {
    // Evading the rule by not wiring the reference must not work.
    const r = report();
    checkPublicInvokerBindings(
      [
        service(JUSTIFIED),
        { type: MEMBER, name: "loose", props: { member: "allUsers", role: "roles/run.invoker" } },
      ],
      r,
    );
    expect(r).toHaveBeenCalledOnce();
  });
});

