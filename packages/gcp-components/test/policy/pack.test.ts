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

describe("policy pack isolation", () => {
  /**
   * The pack cannot run from a tree whose nearest `typescript` is the repo's
   * TypeScript 7. Each assertion below encodes a failure that was *measured*,
   * not anticipated — and each failure is silent at the point it happens: the
   * pack simply never loads, and a stack sails through unenforced.
   */
  const packageJson = (): { dependencies?: Record<string, string> } =>
    JSON.parse(
      readFileSync(join(root, "policy", "package.json"), "utf-8"),
    ) as { dependencies?: Record<string, string> };

  const installTask = (): string => {
    const tasks = JSON.parse(
      readFileSync(join(root, ".projen", "tasks.json"), "utf-8"),
    ) as { tasks: Record<string, { steps: { exec?: string }[] }> };
    return tasks.tasks["policy:install"].steps.map((s) => s.exec ?? "").join(" ");
  };

  it("pins a TypeScript that actually has a compiler API", () => {
    const ts = packageJson().dependencies?.typescript;
    expect(ts).toBeDefined();
    // TS 7 is the native compiler: it exports `version` and `versionMajorMinor`
    // and nothing else. ts-node reaches for `ts.sys` and dies.
    expect(Number.parseInt(ts as string, 10)).toBeLessThan(7);
  });

  it("does NOT align the pack's TypeScript with the repo's", () => {
    // The realistic regression: someone tidies the two pins into one. That is
    // precisely the change that breaks the pack, so it is asserted against.
    const repoTs = (
      JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
        devDependencies: Record<string, string>;
      }
    ).devDependencies.typescript;
    expect(packageJson().dependencies?.typescript).not.toBe(repoTs);
  });

  it("installs with --install-links, or npm symlinks the package and undoes the isolation", () => {
    // Without it npm symlinks a local package; Node resolves through the real
    // path, landing back in the monorepo where TypeScript 7 resolves. Measured:
    // the symlinked form fails with the same ts.sys.readFile error as no
    // isolation at all.
    expect(installTask()).toContain("--install-links");
  });

  it("installs outside node_modules, which npm ci deletes", () => {
    const task = installTask();
    expect(task).toMatch(/--prefix\s+\.runway-policy/);
    expect(task).not.toMatch(/--prefix\s+node_modules/);
  });

  it("clears the install directory first, or npm serves a stale pack", () => {
    // npm skips re-copying a package it already has at the same version, and
    // this package's version never changes. Measured: a rebuilt pack with two
    // new rules did not propagate, and the preview went green with those rules
    // absent -- indistinguishable from them passing.
    expect(installTask()).toMatch(/rm -rf\s+\.runway-policy/);
  });

  it("installs the pack's own Pulumi runtime, not the consumer's", () => {
    // Resolution starts from @pulumi/pulumi's location, so the runner must live
    // in the isolated tree too -- otherwise it resolves the consumer's compiler.
    expect(installTask()).toContain("@pulumi/pulumi@");
  });
});

