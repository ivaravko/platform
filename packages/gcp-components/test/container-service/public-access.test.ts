import { describe, expect, it } from "vitest";
import { resolve, resourcesFor, testServiceAccount } from "../setup";
import { SecureContainerService } from "../../src/container-service/secure-container-service";

/**
 * SecureContainerService — the public access path.
 *
 * The escape hatch, and the auditability that makes it acceptable. Going public
 * is not a boolean: it costs a justification, and that justification is written
 * onto the resource so it is visible from `gcloud` without reading any source.
 */

const IMAGE = "europe-west1-docker.pkg.dev/p/r/api:v1";
const JUSTIFICATION = "handles public webhooks from Stripe";

const IAM_MEMBER = "gcp:cloudrunv2/serviceIamMember:ServiceIamMember";

const publicService = (name: string, justification = JUSTIFICATION): SecureContainerService =>
  new SecureContainerService(name, {
    location: "europe-west1",
    image: IMAGE,
    serviceAccount: testServiceAccount(),
    publicAccess: { justification },
  });

const privateService = (name: string): SecureContainerService =>
  new SecureContainerService(name, {
    location: "europe-west1",
    image: IMAGE,
    serviceAccount: testServiceAccount(),
  });

describe("CR-02: public exposure requires a justification", () => {
  it("accepts a non-empty justification", () => {
    expect(() => publicService("cr02-ok")).not.toThrow();
  });

  it.each([
    ["an empty string", ""],
    ["a single space", " "],
    ["whitespace only", "   \t\n  "],
  ])("rejects %s, which satisfies the type but defeats the control", (_label, justification) => {
    expect(() => publicService("cr02-blank", justification)).toThrow(/justification/i);
  });

  it("reports itself as public", () => {
    expect(publicService("cr02-flag").isPublic).toBe(true);
  });
});

describe("CR-03: invoker binding only on the justified public path", () => {
  it("emits exactly one allUsers invoker binding when public", async () => {
    const svc = publicService("cr03-public");
    await expect(resolve(svc.service.ingress)).resolves.toBe("INGRESS_TRAFFIC_ALL");
    const bindings = (await resourcesFor("cr03-public")).filter((r) => r.type === IAM_MEMBER);
    expect(bindings).toHaveLength(1);
  });

  it("emits no invoker binding at all on the private path", async () => {
    const svc = privateService("cr03-private");
    // Resolve first: the registry is populated asynchronously, so asserting
    // absence too early passes whether or not a binding was ever emitted.
    await resolve(svc.service.ingress);
    const created = await resourcesFor("cr03-private");
    expect(created.filter((r) => r.type === IAM_MEMBER)).toHaveLength(0);
    // Guard against the assertion above passing because nothing registered.
    expect(created.length).toBeGreaterThan(0);
  });

  it("re-enables default URI resolution, since the service is reachable anyway", async () => {
    await expect(resolve(publicService("cr03-uri").service.defaultUriDisabled)).resolves.toBe(
      false,
    );
  });
});

describe("CR-08: the justification is recorded on the resource", () => {
  it("round-trips the justification into description, verbatim", async () => {
    const description = await resolve(publicService("cr08-desc").service.description);
    expect(description).toContain(JUSTIFICATION);
  });

  it("does not mangle a justification containing characters a label would reject", async () => {
    // The reason this is `description` and not a label: GCP label values allow
    // only lowercase alphanumerics, '-' and '_', max 63 chars. A real sentence
    // is rejected outright, so the component would fail at deploy time on its
    // own escape hatch.
    const awkward = "Stripe webhooks (PCI scope) — approved by security, ticket SEC-1421";
    const description = await resolve(publicService("cr08-awkward", awkward).service.description);
    expect(description).toContain(awkward);
  });

  it("sets a label-safe runway-public marker so public services are greppable", async () => {
    const labels = await resolve(publicService("cr08-label").service.labels);
    expect(labels?.["runway-public"]).toBe("true");
  });

  it("keeps every emitted label within GCP's value constraints", async () => {
    const labels = await resolve(publicService("cr08-valid").service.labels);
    for (const [key, value] of Object.entries(labels ?? {})) {
      expect(value, `label ${key}`).toMatch(/^[a-z0-9_-]{0,63}$/);
    }
  });

  it("writes no description or marker label on the private path", async () => {
    const svc = privateService("cr08-private");
    await expect(resolve(svc.service.description)).resolves.toBeUndefined();
    const labels = await resolve(svc.service.labels);
    expect(labels?.["runway-public"]).toBeUndefined();
  });
});
