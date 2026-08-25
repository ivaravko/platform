import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { allPolicies, resourcePolicies, stackPolicies } from "../../src/policy/policies";
import { hasJustification } from "../../src/policy/cloud-run-rules";
import { resolve } from "../setup";
import { SecureContainerService } from "../../src/container-service/secure-container-service";

/**
 * Pack wiring and configuration.
 *
 * Note what is *not* constructed here: `PolicyPack` itself registers with the
 * Pulumi engine, so building one needs a running engine. The policy array is
 * exported separately precisely so the wiring stays assertable offline.
 */

const root = join(__dirname, "..", "..");

describe("policy pack wiring", () => {
  it("registers every rule", () => {
    expect(allPolicies).toHaveLength(resourcePolicies.length + stackPolicies.length);
    expect(allPolicies.length).toBeGreaterThanOrEqual(5);
  });

  it("makes every policy blocking", () => {
    // An advisory guardrail is a report, not a guardrail.
    for (const policy of allPolicies) {
      expect(policy.enforcementLevel, policy.name).toBe("mandatory");
    }
  });

  it("names every policy after the control it enforces", () => {
    const names = allPolicies.map((p) => p.name).join(" ");
    for (const control of ["cr01", "cr03", "cr04", "cr05", "cr09"]) {
      expect(names, control).toContain(control);
    }
  });

  it("gives every policy a description", () => {
    for (const policy of allPolicies) {
      expect(policy.description?.length ?? 0, policy.name).toBeGreaterThan(20);
    }
  });
});

describe("policy pack configuration", () => {
  const yaml = (): string => readFileSync(join(root, "policy", "PulumiPolicy.yaml"), "utf-8");

  it("disables TypeScript, without which the pack cannot run at all", () => {
    // Pulumi runs .ts through ts-node, which throws under TS 7. It loads ts-node
    // only when runtime.options.typescript is true. Flipping this breaks the
    // pack silently at deploy time, far from any test.
    expect(yaml()).toMatch(/typescript:\s*false/);
  });

  it("declares the nodejs runtime", () => {
    expect(yaml()).toMatch(/name:\s*nodejs/);
  });

  it("has an entry point that requires compiled output, never a .ts source", () => {
    const entry = readFileSync(join(root, "policy", "index.js"), "utf-8");
    expect(entry).toContain("../lib/policy/pack");
    expect(entry).not.toMatch(/\.ts["']/);
  });
});

describe("component and policy pack agree", () => {
  it("a justification written by the component satisfies the rule that reads it", async () => {
    // The end-to-end contract. The component writes `description`; the policy
    // rules read it as evidence. If the two ever drift, nothing fails — the
    // guardrail just quietly stops recognising its own output.
    const svc = new SecureContainerService("contract", {
      location: "europe-west1",
      image: "europe-west1-docker.pkg.dev/p/r/api:v1",
      serviceAccountEmail: "api-runtime@my-proj.iam.gserviceaccount.com",
      publicAccess: { justification: "handles public webhooks from Stripe" },
    });
    const description = await resolve(svc.service.description);
    expect(hasJustification(description)).toBe(true);
  });

  it("a private service's absent description does not satisfy the rule", async () => {
    const svc = new SecureContainerService("contract-private", {
      location: "europe-west1",
      image: "europe-west1-docker.pkg.dev/p/r/api:v1",
      serviceAccountEmail: "api-runtime@my-proj.iam.gserviceaccount.com",
    });
    const description = await resolve(svc.service.description);
    expect(hasJustification(description)).toBe(false);
  });
});
