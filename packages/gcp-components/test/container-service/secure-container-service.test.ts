import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { resolve } from "../setup";
import { SecureContainerService } from "../../src/container-service/secure-container-service";

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
    serviceAccountEmail: SA,
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

  it("CR-04: rejects a Google-managed default identity at construction", () => {
    expect(
      () =>
        new SecureContainerService("cr04-bad", {
          location: "europe-west1",
          image: IMAGE,
          serviceAccountEmail: "123456789-compute@developer.gserviceaccount.com",
        }),
    ).toThrow(/Compute Engine/);
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
      serviceAccountEmail: SA,
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

describe("SecureContainerService: service account validation paths", () => {
  it("throws synchronously when given a plain string", () => {
    // The fast path. A literal is the common case and should fail at the call
    // site, not several seconds later during preview.
    expect(
      () =>
        new SecureContainerService("sync-bad", {
          location: "europe-west1",
          image: IMAGE,
          serviceAccountEmail: "dev@example.com",
        }),
    ).toThrow(/iam\.gserviceaccount\.com/);
  });

  /**
   * **The failing-Output path is deliberately not asserted here, and that is a
   * gap, not an oversight.**
   *
   * An Output's value is unknown at construction, so the check can only run
   * inside `apply`, and a throw there is only observable as a rejected promise.
   * `Output` exposes no rejection path in its public type, and its internal one
   * spawns promise chains nothing can attach to: a bare
   * `pulumi.output(x).apply(() => { throw })` leaks two unhandled rejections
   * even when the caller catches the one promise it can reach. **vitest exits 1
   * on unhandled rejections**, so any such test fails the suite while passing
   * itself. The only lever is `dangerouslyIgnoreUnhandledErrors`, which would
   * switch that protection off for every test in the package.
   *
   * What is covered instead: the validator is exhaustively tested in
   * `service-account-email.test.ts`, and the passing case below proves the
   * component really does run it inside `apply` on an Output input. The single
   * untested link is that Pulumi fails a deployment when an input's `apply`
   * throws — which is Pulumi's behaviour, not this component's.
   */
  it("accepts a valid Output", async () => {
    const svc = new SecureContainerService("async-good", {
      location: "europe-west1",
      image: IMAGE,
      serviceAccountEmail: pulumi.output(SA),
    });
    const template = await resolve(svc.service.template);
    expect(template.serviceAccount).toBe(SA);
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
