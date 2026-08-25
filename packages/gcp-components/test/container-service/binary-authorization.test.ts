import { describe, expect, it } from "vitest";
import { resolve, testServiceAccount } from "../setup";
import {
  SecureContainerService,
  type SecureContainerServiceArgs,
} from "../../src/container-service/secure-container-service";

/**
 * CR-09: Binary Authorization is opt-in, and breakglass is unreachable.
 *
 * Note this closes SPEC.md Open Question 4 on different terms than it was
 * asked. That question assumes Binary Authorization "requires an attestor"; the
 * verified `ServiceBinaryAuthorization` type has no attestor field at all. It is
 * `{ useDefault, policy, breakglassJustification }` — the resource selects the
 * project's default policy or names one by path, and attestors are configured on
 * the policy, out of band.
 */

const IMAGE = "europe-west1-docker.pkg.dev/p/r/api:v1";
const POLICY = "projects/my-proj/platforms/cloudRun/prod-policy";

const service = (
  name: string,
  binaryAuthorization?: SecureContainerServiceArgs["binaryAuthorization"],
): SecureContainerService =>
  new SecureContainerService(name, {
    location: "europe-west1",
    image: IMAGE,
    serviceAccount: testServiceAccount(),
    binaryAuthorization,
  });

describe("CR-09: Binary Authorization is opt-in", () => {
  it("emits no binaryAuthorization block at all when the arg is omitted", async () => {
    // Absent, not an empty object. `useDefault` fails every deployment in a
    // project with no BinAuthz policy configured, so it cannot be a library
    // default -- and an empty block would still change the resource.
    await expect(
      resolve(service("cr09-absent").service.binaryAuthorization),
    ).resolves.toBeUndefined();
  });

  it("selects the project default policy when asked", async () => {
    const emitted = await resolve(
      service("cr09-default", { useDefault: true }).service.binaryAuthorization,
    );
    expect(emitted?.useDefault).toBe(true);
  });

  it("names an explicit policy when given one", async () => {
    const emitted = await resolve(
      service("cr09-policy", { policy: POLICY }).service.binaryAuthorization,
    );
    expect(emitted?.policy).toBe(POLICY);
  });
});

describe("CR-09: breakglass is not reachable", () => {
  it("is rejected by the args type", () => {
    // A compile-time assertion, and it is live: `npm test` now spawns
    // `tsc --noEmit -p test/tsconfig.json`. If the args type ever admits
    // breakglassJustification, @ts-expect-error becomes unused and tsc fails.
    const attempted: SecureContainerServiceArgs["binaryAuthorization"] = {
      useDefault: true,
      // @ts-expect-error breakglassJustification is the documented way to
      // bypass the policy this control exists to apply. It must stay unreachable.
      breakglassJustification: "bypass the policy",
    };
    expect(attempted).toBeDefined();
  });

  it("never appears in the emitted configuration", async () => {
    for (const [name, arg] of [
      ["cr09-bg-default", { useDefault: true } as const],
      ["cr09-bg-policy", { policy: POLICY } as const],
    ]) {
      const emitted = await resolve(
        service(name as string, arg as SecureContainerServiceArgs["binaryAuthorization"])
          .service.binaryAuthorization,
      );
      expect(emitted?.breakglassJustification).toBeUndefined();
    }
  });
});
