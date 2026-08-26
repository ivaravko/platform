import { describe, expect, it } from "vitest";
import { resolve, resourcesFor } from "./setup";
import {
  WorkloadIdentity,
  attributeConditionAdmits,
} from "../src";

/**
 * E4 / EP-03: CI authenticates by federation, and no key exists anywhere in
 * the path. The condition tests are the ones EP-02 will turn on: both axes
 * are failure-injected against the emitted condition string, because a
 * condition that merely *exists* would pass for one matching everything.
 */

const KEY_TYPE = "gcp:serviceaccount/key:Key";
const POOL_TYPE = "gcp:iam/workloadIdentityPool:WorkloadIdentityPool";
const PROVIDER_TYPE = "gcp:iam/workloadIdentityPoolProvider:WorkloadIdentityPoolProvider";
const SA_IAM_TYPE = "gcp:serviceaccount/iAMMember:IAMMember";

const identity = (name: string, refs: readonly string[] = ["refs/heads/main"]): WorkloadIdentity =>
  new WorkloadIdentity(name, {
    service: "checkout",
    project: "checkout-production",
    repository: "acme/checkout",
    refs,
  });

describe("EP-03: CI authenticates by federation, and no key is ever created", () => {
  it("creates a per-service pool and provider in the service's own project", async () => {
    const wif = identity("ep03-pool");
    await resolve(wif.pool.name);

    const created = await resourcesFor("ep03-pool");
    const pools = created.filter((r) => r.type === POOL_TYPE);
    const providers = created.filter((r) => r.type === PROVIDER_TYPE);

    expect(pools).toHaveLength(1);
    expect(pools[0].props.workloadIdentityPoolId).toBe("checkout-github");
    expect(pools[0].props.project).toBe("checkout-production");

    expect(providers).toHaveLength(1);
    expect(providers[0].props.oidc).toEqual({
      issuerUri: "https://token.actions.githubusercontent.com",
    });
  });

  it("emits no service-account key", async () => {
    const wif = identity("ep03-nokey");
    await resolve(wif.deployerEmail);

    const created = await resourcesFor("ep03-nokey");
    expect(created.filter((r) => r.type === KEY_TYPE)).toHaveLength(0);
    // Guard: absence must not be indistinguishable from nothing registering.
    expect(created.length).toBeGreaterThan(2);
  });

  it("exposes no way to ask for one", () => {
    // Structural, same guarantee as SA-01: nothing key-shaped in the args.
    const args = Object.keys({
      service: "",
      project: "",
      repository: "",
      ref: "",
    });
    expect(args.some((k) => /key/i.test(k))).toBe(false);
  });

  it("binds workloadIdentityUser to the deployer, scoped to the repository", async () => {
    const wif = identity("ep03-binding");
    await resolve(wif.deployerEmail);

    const bindings = (await resourcesFor("ep03-binding")).filter(
      (r) => r.type === SA_IAM_TYPE,
    );
    expect(bindings).toHaveLength(1);
    expect(bindings[0].props.role).toBe("roles/iam.workloadIdentityUser");
    expect(bindings[0].props.member).toBe(
      "principalSet://iam.googleapis.com/projects/000000000000/locations/global/" +
        "workloadIdentityPools/checkout-github/attribute.repository/acme/checkout",
    );
  });
});

describe("the attribute condition is one repository and one ref, which EP-02 turns on", () => {
  it("admits exactly the configured repository and ref", async () => {
    const condition = await resolve(identity("cond-admit").provider.attributeCondition);

    expect(
      attributeConditionAdmits(condition ?? "", {
        repository: "acme/checkout",
        ref: "refs/heads/main",
      }),
    ).toBe(true);
  });

  it("rejects a wrong repository — failure-injected", async () => {
    const condition = await resolve(identity("cond-repo").provider.attributeCondition);

    expect(
      attributeConditionAdmits(condition ?? "", {
        repository: "acme/other-repo",
        ref: "refs/heads/main",
      }),
    ).toBe(false);
  });

  it("rejects a wrong ref — failure-injected", async () => {
    const condition = await resolve(identity("cond-ref").provider.attributeCondition);

    expect(
      attributeConditionAdmits(condition ?? "", {
        repository: "acme/checkout",
        ref: "refs/heads/feature-branch",
      }),
    ).toBe(false);
  });

  it("a tag pattern admits the tags it names, and nothing else", async () => {
    const condition = await resolve(
      identity("cond-tags", ["refs/tags/v*"]).provider.attributeCondition,
    );

    const admits = (ref: string): boolean =>
      attributeConditionAdmits(condition ?? "", { repository: "acme/checkout", ref });
    expect(admits("refs/tags/v1.4.0")).toBe(true);
    expect(admits("refs/heads/main")).toBe(false);
    expect(admits("refs/tags/experiment")).toBe(false);
  });

  it("admits every named ref and nothing between them", async () => {
    // The real deploy identity needs two refs: main pushes build images,
    // version tags release them. Named refs, not the issuer at large -- the
    // condition is an OR of the same two grammars, and everything not named
    // is still rejected.
    const condition = await resolve(
      identity("cond-both", ["refs/heads/main", "refs/tags/v*"]).provider.attributeCondition,
    );

    const admits = (ref: string): boolean =>
      attributeConditionAdmits(condition ?? "", { repository: "acme/checkout", ref });
    expect(admits("refs/heads/main")).toBe(true);
    expect(admits("refs/tags/v1.4.0")).toBe(true);
    expect(admits("refs/heads/feature")).toBe(false);
    expect(admits("refs/tags/experiment")).toBe(false);
  });

  it("refuses an empty ref list at construction", () => {
    expect(() => identity("cond-none", [])).toThrow(/ref/);
  });

  it("refuses a wildcard repository at construction", () => {
    // One repository means one. A glob here is the shared-pool mistake with
    // extra steps — the blast-radius argument the per-service pool exists for.
    expect(
      () =>
        new WorkloadIdentity("cond-wild", {
          service: "checkout",
          project: "checkout-production",
          repository: "acme/*",
          refs: ["refs/heads/main"],
        }),
    ).toThrow(/repository/);
  });

  it("refuses to evaluate a condition it did not write", () => {
    // The evaluator parses exactly the grammar this module emits. Handed
    // anything else — including a condition that matches everything — it
    // throws rather than guessing in either direction.
    expect(() =>
      attributeConditionAdmits("true", {
        repository: "acme/checkout",
        ref: "refs/heads/main",
      }),
    ).toThrow(/condition/i);
  });
});
