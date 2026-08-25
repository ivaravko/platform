import { describe, expect, it } from "vitest";
import { assertUserManagedServiceAccount } from "../../src/container-service/service-account-email";
import * as publicApi from "../../src";

/**
 * CR-04: a Cloud Run service runs under a user-managed service account.
 *
 * This control carries more weight than the module spec originally intended.
 * SPEC-gcp-components.md makes the runtime identity a typed `SecureServiceAccount`,
 * so the default compute SA is unreachable through the type system. That
 * component does not exist yet, so v1 validates an email string instead — a
 * compile-time guarantee traded for a runtime one, deliberately.
 *
 * The check is a **positive rule**: only `<id>@<project>.iam.gserviceaccount.com`
 * is accepted. Every Google-managed default sits outside that domain and is
 * rejected without being named. A denylist would need updating each time Google
 * adds a default identity; the positive rule never does.
 */

const VALID = "api-runtime@my-proj.iam.gserviceaccount.com";

/** A valid address whose id part is exactly `length` characters. */
const emailWithIdLength = (length: number): string =>
  `${"a".repeat(length)}@p.iam.gserviceaccount.com`;

describe("CR-04: runtime service account is user-managed", () => {
  it("accepts a user-managed service account", () => {
    expect(() => assertUserManagedServiceAccount(VALID)).not.toThrow();
  });

  it("is reachable from the package entry point, so consumers never deep-import", () => {
    expect(publicApi.assertUserManagedServiceAccount).toBe(assertUserManagedServiceAccount);
  });

  describe("rejects Google-managed default identities", () => {
    const defaults: readonly [string, string, string][] = [
      ["default Compute Engine", "123456789-compute@developer.gserviceaccount.com", "Compute Engine"],
      ["default App Engine", "my-proj@appspot.gserviceaccount.com", "App Engine"],
      ["default Cloud Build", "123456789@cloudbuild.gserviceaccount.com", "Cloud Build"],
    ];

    it.each(defaults)("rejects the %s service account", (_label, email) => {
      expect(() => assertUserManagedServiceAccount(email)).toThrow();
    });

    it.each(defaults)("names %s in the message, so the reader knows what they passed", (_l, email, identity) => {
      expect(() => assertUserManagedServiceAccount(email)).toThrow(new RegExp(identity));
    });

    it.each(defaults)("tells the reader what to do instead, for the %s account", (_label, email) => {
      // An error that only says "invalid" leaves the reader to guess. The whole
      // point of the control is that they end up with a dedicated account.
      expect(() => assertUserManagedServiceAccount(email)).toThrow(
        /[Cc]reate a dedicated service account/,
      );
    });
  });

  it("rejects an identity Google adds tomorrow, which no hint list could know about", () => {
    // The discriminating test. The hint list exists only to improve messages;
    // if it were the security boundary, an unlisted Google default would pass.
    expect(() =>
      assertUserManagedServiceAccount("999-brandnew@someservice.gserviceaccount.com"),
    ).toThrow();
  });

  it("rejects a human email address", () => {
    expect(() => assertUserManagedServiceAccount("dev@example.com")).toThrow();
  });

  it("names the expected shape when it has no better hint", () => {
    expect(() => assertUserManagedServiceAccount("dev@example.com")).toThrow(
      /iam\.gserviceaccount\.com/,
    );
  });

  describe("enforces GCP's own service-account id rules", () => {
    it("accepts the minimum id length of 6", () => {
      expect(() => assertUserManagedServiceAccount(emailWithIdLength(6))).not.toThrow();
    });

    it("rejects an id of 5, below GCP's minimum", () => {
      expect(() => assertUserManagedServiceAccount(emailWithIdLength(5))).toThrow();
    });

    it("accepts the maximum id length of 30", () => {
      expect(() => assertUserManagedServiceAccount(emailWithIdLength(30))).not.toThrow();
    });

    it("rejects an id of 31, above GCP's maximum", () => {
      expect(() => assertUserManagedServiceAccount(emailWithIdLength(31))).toThrow();
    });

    it.each([
      ["a leading digit", "1service@p.iam.gserviceaccount.com"],
      ["uppercase characters", "API-SVC@p.iam.gserviceaccount.com"],
      ["a trailing hyphen", "service-@p.iam.gserviceaccount.com"],
      ["an empty string", ""],
    ])("rejects %s", (_label, address) => {
      expect(() => assertUserManagedServiceAccount(address)).toThrow();
    });
  });
});
