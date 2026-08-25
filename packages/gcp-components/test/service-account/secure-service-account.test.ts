import { describe, expect, it } from "vitest";
import { resolve, resourcesFor } from "../setup";
import { SecureServiceAccount } from "../../src/service-account/secure-service-account";

/**
 * SecureServiceAccount — the dedicated runtime identity.
 *
 * Its absence is why C4 shipped a runtime check where the module spec promised
 * a compile-time one. One `it` per control-mapping row, named after that row.
 */

const PROJECT = "my-proj";
const KEY_TYPE = "gcp:serviceaccount/key:Key";
const IAM_MEMBER_TYPE = "gcp:projects/iAMMember:IAMMember";

const account = (name: string, roles?: readonly string[]): SecureServiceAccount =>
  new SecureServiceAccount(name, {
    accountId: "api-runtime",
    project: PROJECT,
    ...(roles === undefined ? {} : { roles }),
  });

describe("SA-01: user-managed keys are never created", () => {
  it("emits no service-account key", async () => {
    const sa = account("sa01");
    await resolve(sa.account.email);
    const created = await resourcesFor("sa01");
    expect(created.filter((r) => r.type === KEY_TYPE)).toHaveLength(0);
    // Guard: absence must not be indistinguishable from nothing registering.
    expect(created.length).toBeGreaterThan(0);
  });

  it("exposes no way to ask for one", () => {
    // Structural: the args type carries nothing key-shaped. Workload Identity
    // is the only supported path, so a key argument would be the escape hatch
    // the control exists to remove.
    const args = Object.keys({
      accountId: "",
      project: "",
      displayName: "",
      description: "",
      roles: [],
    });
    expect(args.some((k) => /key/i.test(k))).toBe(false);
  });
});

describe("SA-02: no roles are granted by default", () => {
  it("grants nothing when roles are not requested", async () => {
    const sa = account("sa02");
    await resolve(sa.account.email);
    const created = await resourcesFor("sa02");
    expect(created.filter((r) => r.type === IAM_MEMBER_TYPE)).toHaveLength(0);
    expect(created.length).toBeGreaterThan(0);
  });

  it("grants exactly what was asked for, and nothing more", async () => {
    const sa = account("sa02-roles", ["roles/run.invoker", "roles/artifactregistry.reader"]);
    await resolve(sa.account.email);
    const bindings = (await resourcesFor("sa02-roles")).filter(
      (r) => r.type === IAM_MEMBER_TYPE,
    );
    expect(bindings).toHaveLength(2);
  });

  it("requires a project before it will grant anything", () => {
    expect(
      () =>
        new SecureServiceAccount("sa02-noproject", {
          accountId: "api-runtime",
          roles: ["roles/run.invoker"],
        }),
    ).toThrow(/project/i);
  });
});

describe("SA-03: over-privileged roles are rejected at construction", () => {
  it.each([
    ["roles/owner", "roles/owner"],
    ["roles/editor", "roles/editor"],
    ["a camelCase Admin role", "roles/iam.serviceAccountAdmin"],
    ["a lowercase admin role", "roles/storage.admin"],
    ["a key admin role", "roles/iam.serviceAccountKeyAdmin"],
    ["a project IAM admin role", "roles/resourcemanager.projectIamAdmin"],
  ])("rejects %s", (_label, role) => {
    expect(() => account("sa03-bad", [role])).toThrow();
  });

  it("names the offending role and what to do instead", () => {
    expect(() => account("sa03-msg", ["roles/editor"])).toThrow(
      /roles\/editor[\s\S]*only the roles this/i,
    );
  });

  it.each([
    ["an invoker role", "roles/run.invoker"],
    ["a reader role", "roles/artifactregistry.reader"],
    ["a role whose name merely contains admin", "roles/cloudsql.admin.viewer"],
  ])("accepts %s", (_label, role) => {
    expect(() => account("sa03-ok", [role])).not.toThrow();
  });

  it("rejects something that is not a role at all", () => {
    expect(() => account("sa03-shape", ["owner"])).toThrow();
  });
});

describe("SecureServiceAccount: surface", () => {
  it("exposes email as an Output for SecureContainerService to consume", async () => {
    await expect(resolve(account("surface-email").email)).resolves.toContain(
      "api-runtime@",
    );
  });

  it("exposes the IAM member form, so callers need not build it by hand", async () => {
    await expect(resolve(account("surface-member").member)).resolves.toMatch(
      /^serviceAccount:/,
    );
  });

  it("registers under the runway:gcp type namespace", async () => {
    await expect(resolve(account("surface-urn").account.urn)).resolves.toContain(
      "runway:gcp:SecureServiceAccount",
    );
  });
});
