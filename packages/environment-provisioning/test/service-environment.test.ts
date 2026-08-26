import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve, resourcesFor } from "./setup";
import { ServiceEnvironment } from "../src";

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
    // The type has no ci arm yet, so production is unconstructible in this
    // slice — loudly, naming the control it would otherwise soften.
    expect(() =>
      new ServiceEnvironment("prod-humans", {
        service: "checkout",
        environment: "production",
        location: "europe-west1",
        deployableBy: { humans: { group: "developers@acme.com" } },
      }),
    ).toThrow(/leave EP-01 unenforced/);
  });
});
