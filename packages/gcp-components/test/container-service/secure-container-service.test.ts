import { describe, expect, it } from "vitest";
import { resolve, testServiceAccount } from "../setup";
import {
  SecureContainerService,
  type SecureContainerServiceArgs,
} from "../../src/container-service/secure-container-service";

/**
 * SecureContainerService — the private default path.
 *
 * One `it` per control-mapping row, named after that row, so a missing control
 * is a missing test name rather than something a reviewer has to notice.
 *
 * Every assertion resolves an `Output`. Asserting on constructor arguments
 * would only prove we can read back what we passed in; the claim being tested
 * is what the provider actually receives.
 */

const SA = "api-runtime@my-proj.iam.gserviceaccount.com";
const IMAGE = "europe-west1-docker.pkg.dev/p/r/api:v1";

/** A service built from the three required args and nothing else. */
const defaults = (name: string): SecureContainerService =>
  new SecureContainerService(name, {
    location: "europe-west1",
    image: IMAGE,
    serviceAccount: testServiceAccount(),
  });

describe("SecureContainerService: private default path", () => {
  it("CR-01: defaults ingress to internal load balancer only", async () => {
    await expect(resolve(defaults("cr01").service.ingress)).resolves.toBe(
      "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    );
  });

  it("CR-04: passes the validated service account to the revision template", async () => {
    const template = await resolve(defaults("cr04").service.template);
    expect(template.serviceAccount).toBe(SA);
  });

  it("CR-05: never sets invokerIamDisabled", async () => {
    // It disables the IAM permission check on run.routes.invoke -- a wider hole
    // than allUsers, and invisible in an IAM policy dump. Not exposed, never set.
    await expect(
      resolve(defaults("cr05").service.invokerIamDisabled),
    ).resolves.toBeUndefined();
  });

  it("CR-06: enables deletion protection by default", async () => {
    await expect(
      resolve(defaults("cr06").service.deletionProtection),
    ).resolves.toBe(true);
  });

  it("CR-06: disables deletion protection only through the justified opt-out", async () => {
    const svc = new SecureContainerService("cr06-opt", {
      location: "europe-west1",
      image: IMAGE,
      serviceAccount: testServiceAccount(),
      deletionProtection: { disableJustification: "ephemeral preview environment" },
    });
    await expect(resolve(svc.service.deletionProtection)).resolves.toBe(false);
  });

  it("CR-07: disables default URI resolution on the private path", async () => {
    await expect(
      resolve(defaults("cr07").service.defaultUriDisabled),
    ).resolves.toBe(true);
  });
});

describe("SecureContainerService: nothing public leaks in by default", () => {
  it("CR-08: writes no description when there is no justification to record", async () => {
    await expect(resolve(defaults("no-desc").service.description)).resolves.toBeUndefined();
  });

  it("CR-03: sets no runway-public label", async () => {
    const labels = await resolve(defaults("no-label").service.labels);
    expect(labels?.["runway-public"]).toBeUndefined();
  });

  it("reports itself as not public", () => {
    expect(defaults("not-public").isPublic).toBe(false);
  });
});

describe("SecureContainerService: surfaces cut from v1", () => {
  it("emits no vpcAccess or encryptionKey in the template", async () => {
    // No cast: vpcAccess and encryptionKey are real optional properties of
    // ServiceTemplate, so asserting they are absent is type-checked too.
    const template = await resolve(defaults("cut-tpl").service.template);
    expect(template.vpcAccess).toBeUndefined();
    expect(template.encryptionKey).toBeUndefined();
  });

  it("emits no iapEnabled on the service", async () => {
    await expect(resolve(defaults("cut-iap").service.iapEnabled)).resolves.toBeUndefined();
  });
});

describe("CR-04: the default identity is unreachable, not merely rejected", () => {
  it("rejects a bare email string at compile time", () => {
    // A compile-time assertion, and a live one: `npm test` spawns
    // `tsc --noEmit -p test/tsconfig.json`. If the argument ever widens back to
    // a string, @ts-expect-error becomes unused and tsc fails.
    //
    // This replaces C4's runtime check. That check had a half nothing could
    // test: an Output's value is unknown at construction, so validation ran
    // inside `apply`, and a throw there is observable only as a rejected
    // promise that leaks unhandled rejections vitest treats as fatal. The gap
    // is gone rather than documented, because there is no longer a string to
    // validate.
    const args: SecureContainerServiceArgs = {
      location: "europe-west1",
      image: IMAGE,
      // @ts-expect-error a service account is a SecureServiceAccount, never an
      // email string -- which is what makes the default compute identity
      // impossible to name.
      serviceAccount: "123456789-compute@developer.gserviceaccount.com",
    };
    expect(args).toBeDefined();
  });

  it("derives the runtime identity from the component, not from a caller string", async () => {
    const sa = testServiceAccount();
    const svc = new SecureContainerService("typed-sa", {
      location: "europe-west1",
      image: IMAGE,
      serviceAccount: sa,
    });
    const template = await resolve(svc.service.template);
    await expect(resolve(sa.email)).resolves.toBe(template.serviceAccount);
  });
});

describe("SecureContainerService: component identity", () => {
  it("registers under the runway:gcp type namespace", async () => {
    await expect(resolve(defaults("urn").service.urn)).resolves.toContain(
      "runway:gcp:SecureContainerService",
    );
  });

  it("exposes the service uri", async () => {
    await expect(resolve(defaults("uri").uri)).resolves.toContain("uri-mocked-ew.a.run.app");
  });
});
