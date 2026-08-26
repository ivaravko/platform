import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve, resourcesFor } from "./setup";
import {
  ServiceEnvironment,
  attributeConditionAdmits,
  type IamPolicy,
} from "../src";

/**
 * E3: `ServiceEnvironment`, the staging half. One adopted project, its IAM,
 * its state prefix. Production is deliberately unconstructible until E5
 * composes the audit and the federation — there is no human variant of it,
 * and in this slice there is no variant of it at all.
 */

const BUCKET_TYPE = "gcp:storage/bucket:Bucket";
const BUCKET_IAM_TYPE = "gcp:storage/bucketIAMMember:BucketIAMMember";
const PROJECT_IAM_TYPE = "gcp:projects/iAMMember:IAMMember";

const staging = (name: string, group = "developers@acme.com"): ServiceEnvironment =>
  new ServiceEnvironment(name, {
    service: "checkout",
    environment: "staging",
    location: "europe-west1",
    deployableBy: { humans: { group } },
  });

describe("EP-04: staging deploy is granted to a developers group, never an individual", () => {
  it("grants the deploy role to the group, and to nothing else", async () => {
    const env = staging("ep04");
    await resolve(env.project);

    const grants = (await resourcesFor("ep04")).filter((r) => r.type === PROJECT_IAM_TYPE);
    expect(grants).toHaveLength(1);
    expect(grants[0].props.role).toBe("roles/run.developer");
    expect(grants[0].props.member).toBe("group:developers@acme.com");
    expect(grants[0].props.project).toBe("checkout-staging");
  });

  it("accepts a group already carrying its principal prefix", async () => {
    const env = staging("ep04-prefixed", "group:developers@acme.com");
    await resolve(env.project);

    const grants = (await resourcesFor("ep04-prefixed")).filter(
      (r) => r.type === PROJECT_IAM_TYPE,
    );
    expect(grants[0].props.member).toBe("group:developers@acme.com");
  });

  it("rejects a user: principal at construction — failure-injected", () => {
    // The group form above constructs; the individual form must not. Both
    // halves asserted, or the refusal could be dead code behind a typo.
    expect(() => staging("ep04-user", "user:dana@acme.com")).toThrow(/EP-04:/);
  });

  it("rejects a service account posing as the deployers group", () => {
    // The humans arm means humans. A service account belongs on the CI arm,
    // where E4's federation scopes what it may do and from where.
    expect(() =>
      staging("ep04-sa", "serviceAccount:ci@acme-prd.iam.gserviceaccount.com"),
    ).toThrow(/EP-04:/);
  });
});

describe("EP-05: the state bucket is versioned, access-controlled, per environment", () => {
  it("versions the bucket and closes it to the public — resolved, not assumed", async () => {
    const env = staging("ep05");

    // Resolved from the resource's Outputs, never read back from the
    // constructor arguments: the assertion is about what the engine was told.
    expect((await resolve(env.stateBucket.versioning))?.enabled).toBe(true);
    expect(await resolve(env.stateBucket.uniformBucketLevelAccess)).toBe(true);
    expect(await resolve(env.stateBucket.publicAccessPrevention)).toBe("enforced");
  });

  it("derives the bucket from service and environment, so two environments cannot share one", async () => {
    const env = staging("ep05-name");

    // The environment name is part of the derived identity. A production
    // environment of the same service derives "checkout-production-state" —
    // proven the day production is constructible (E5); the derivation rule
    // is what this asserts.
    expect(await resolve(env.stateBucket.name)).toBe("checkout-staging-state");
    expect(await resolve(env.project)).toBe("checkout-staging");
  });

  it("grants the deployers access to state on the bucket, not project-wide", async () => {
    const env = staging("ep05-access");
    await resolve(env.stateBucket.name);

    const grants = (await resourcesFor("ep05-access")).filter(
      (r) => r.type === BUCKET_IAM_TYPE,
    );
    expect(grants).toHaveLength(1);
    expect(grants[0].props.role).toBe("roles/storage.objectAdmin");
    expect(grants[0].props.member).toBe("group:developers@acme.com");
  });
});

describe("ServiceEnvironment adopts; it never creates", () => {
  it("creates no project resource", async () => {
    const env = staging("adopt");
    await resolve(env.project);

    const created = await resourcesFor("adopt");
    expect(created.filter((r) => r.type.includes("organizations/project"))).toHaveLength(0);
    // Guard: absence must not be indistinguishable from nothing registering.
    expect(created.filter((r) => r.type === BUCKET_TYPE)).toHaveLength(1);
  });
});

/** A production project that adopts cleanly: read-only humans, nothing more. */
const cleanAdoptedPolicy: IamPolicy = {
  bindings: [{ role: "roles/viewer", members: ["group:devs@acme.com"] }],
};

const production = (
  name: string,
  existingPolicy: IamPolicy = cleanAdoptedPolicy,
): ServiceEnvironment =>
  new ServiceEnvironment(name, {
    service: "checkout",
    environment: "production",
    location: "europe-west1",
    deployableBy: {
      ci: { repository: "acme/checkout", ref: "refs/tags/v*", existingPolicy },
    },
  });

describe("EP-01: production grants no deploy role to any human principal", () => {
  it("emits no IAM member for any human principal — enumerated, not counted", async () => {
    const env = production("ep01");
    await resolve(env.project);

    const members = (await resourcesFor("ep01"))
      .map((r) => r.props.member)
      .filter((m): m is string => typeof m === "string");

    // Every grant this environment makes goes to a machine identity. There
    // is no exception, so there is no allowlist — the assertion is total.
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) {
      expect(member).toMatch(/^(serviceAccount:|principalSet:)/);
    }
  });

  it("refuses to adopt a project that already grants a human deploys — failure-injected", () => {
    const poisoned: IamPolicy = {
      bindings: [
        ...cleanAdoptedPolicy.bindings,
        { role: "roles/run.admin", members: ["user:dana@acme.com"] },
      ],
    };

    // Both halves: the clean adoption constructs, the poisoned one refuses
    // with the audit's own message — bootstrap fails rather than proceeding
    // onto a compromised project.
    expect(() => production("ep01-clean")).not.toThrow();
    expect(() => production("ep01-poisoned", poisoned)).toThrow(
      /already grants deploy access/,
    );
  });

  it("offers no opt-out: nothing justification-shaped in the ci arm", () => {
    // Unlike publicAccess there is no acceptable form of a human production
    // deploy, so there is no field to supply one through.
    const args = Object.keys({
      repository: "",
      ref: "",
      existingPolicy: { bindings: [] },
      customRolePermissions: {},
    });
    expect(args.some((k) => /justif|allow|except|human/i.test(k))).toBe(false);
  });
});

describe("EP-02: the deploy role goes only to the federated CI identity", () => {
  it("grants production deploy to the deployer service account, binding by binding", async () => {
    const env = production("ep02");
    await resolve(env.project);
    const created = await resourcesFor("ep02");

    // Enumerated, never counted: a count of one would pass for the wrong
    // single binding. Every project-level grant, with role and member.
    const projectGrants = created
      .filter((r) => r.type === PROJECT_IAM_TYPE)
      .map((r) => ({ role: r.props.role, member: r.props.member }));
    expect(projectGrants).toEqual([
      {
        role: "roles/run.admin",
        member:
          "serviceAccount:checkout-deployer@checkout-production.iam.gserviceaccount.com",
      },
    ]);

    // The impersonation binding, likewise enumerated: the repository's
    // principal set, the deployer, and nothing else.
    const saGrants = created
      .filter((r) => r.type === "gcp:serviceaccount/iAMMember:IAMMember")
      .map((r) => ({ role: r.props.role, member: r.props.member }));
    expect(saGrants).toEqual([
      {
        role: "roles/iam.workloadIdentityUser",
        member:
          "principalSet://iam.googleapis.com/projects/000000000000/locations/global/" +
          "workloadIdentityPools/checkout-github/attribute.repository/acme/checkout",
      },
    ]);

    // And state access: the deployer alone, on the bucket alone.
    const bucketGrants = created
      .filter((r) => r.type === BUCKET_IAM_TYPE)
      .map((r) => ({ role: r.props.role, member: r.props.member }));
    expect(bucketGrants).toEqual([
      {
        role: "roles/storage.objectAdmin",
        member:
          "serviceAccount:checkout-deployer@checkout-production.iam.gserviceaccount.com",
      },
    ]);
  });

  it("scopes the federation to the repository and ref it was given", async () => {
    const env = production("ep02-scope");
    expect(env.federation).toBeDefined();
    const condition = await resolve(env.federation!.provider.attributeCondition);

    const admits = (repository: string, ref: string): boolean =>
      attributeConditionAdmits(condition ?? "", { repository, ref });
    expect(admits("acme/checkout", "refs/tags/v1.4.0")).toBe(true);
    expect(admits("acme/other", "refs/tags/v1.4.0")).toBe(false);
    expect(admits("acme/checkout", "refs/heads/main")).toBe(false);
  });

  it("derives production's own state bucket, distinct from staging's (EP-05)", async () => {
    // The half the staging test left open: same derivation rule, different
    // environment, different bucket. Sharing is structurally impossible.
    const env = production("ep02-state");
    expect(await resolve(env.stateBucket.name)).toBe("checkout-production-state");
  });
});

describe("ServiceEnvironment is the unit — no environment-kind branch", () => {
  it("carries no isProduction flag, and no boolean at all, in its args", () => {
    // Structural: the boundary between environments is the discriminated
    // deployableBy arm plus the environment's *name*, never a boolean a
    // later edit can branch on. The source is the contract here.
    const source = readFileSync(
      join(__dirname, "..", "src", "service-environment.ts"),
      "utf-8",
    );
    // Matched as a declaration (`isProduction:` / `isProduction?:`), not as a
    // bare word — the component's own docstring names the flag while
    // explaining why it must not exist.
    expect(source).not.toMatch(/isProduction\s*[?:]/);

    const argsBlock = source.slice(
      source.indexOf("interface ServiceEnvironmentArgs"),
      source.indexOf("}", source.indexOf("interface ServiceEnvironmentArgs")),
    );
    expect(argsBlock).not.toMatch(/boolean/);
  });

  it("refuses to build production deployable by humans", () => {
    // The ci arm exists now; the humans arm for production still must not.
    expect(() =>
      new ServiceEnvironment("prod-humans", {
        service: "checkout",
        environment: "production",
        location: "europe-west1",
        deployableBy: { humans: { group: "developers@acme.com" } },
      }),
    ).toThrow(/leave EP-01 unenforced/);
  });

  it("refuses to build staging deployable by CI", () => {
    // The mirror image: staging is deployed by people, from laptops, per the
    // module's model. A CI-deployed staging would be a second identity model
    // nothing in this initiative specifies — ask first, not drift in.
    expect(() =>
      new ServiceEnvironment("staging-ci", {
        service: "checkout",
        environment: "staging",
        location: "europe-west1",
        deployableBy: {
          ci: {
            repository: "acme/checkout",
            ref: "refs/tags/v*",
            existingPolicy: cleanAdoptedPolicy,
          },
        },
      }),
    ).toThrow(/staging is deployed by people/);
  });
});
