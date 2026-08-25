import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolve } from "./setup";
import { TYPE_NAMESPACE } from "../src";
import * as gcp from "@pulumi/gcp";

/**
 * C2: proof that Pulumi works on TypeScript 7, inside this repo.
 *
 * This matters because TS 7 is the native compiler and exposes no JS compiler
 * API, which has already broken ts-node and made typescript-eslint uninstallable
 * here. @pulumi/pulumi also peer-caps TypeScript at "< 7", so npm refuses to
 * resolve it without the .npmrc at the repo root.
 *
 * None of that stops the PR gate: the peer range is stale metadata, tsc 7
 * typechecks Pulumi's own .d.ts cleanly, and vitest drives the mocked runtime.
 * These tests are what turn that claim into something CI re-checks, rather than
 * a note in tasks/plan.md.
 */

const root = join(__dirname, "..");

interface PackageJson {
  readonly devDependencies: Record<string, string>;
  readonly peerDependencies: Record<string, string>;
}

const packageJson = (): PackageJson =>
  JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as PackageJson;

describe("toolchain", () => {
  it("pins @pulumi/pulumi exactly", () => {
    expect(packageJson().peerDependencies["@pulumi/pulumi"]).toBe("3.259.0");
  });

  it("pins @pulumi/gcp exactly", () => {
    expect(packageJson().peerDependencies["@pulumi/gcp"]).toBe("9.35.1");
  });

  it("resolves TypeScript 7, not a silently-pinned 5.x", () => {
    expect(packageJson().devDependencies.typescript).toBe("7.0.2");
  });

  it("exposes the Pulumi type-string namespace from the package entry point", () => {
    // SPEC.md: components register as `runway:gcp:<Component>`. Written once
    // here so C3 onward cannot drift.
    expect(TYPE_NAMESPACE).toBe("runway:gcp");
  });
});

describe("pulumi runtime", () => {
  it("constructs a Cloud Run service under mocks, with no credentials", async () => {
    const service = new gcp.cloudrunv2.Service("smoke", {
      location: "europe-west1",
      template: {
        containers: [{ image: "europe-west1-docker.pkg.dev/p/r/api:v1" }],
      },
    });
    await expect(resolve(service.urn)).resolves.toContain("smoke");
  });

  it("round-trips an input through the mocked engine as a resolved Output", async () => {
    // Asserting a resolved Output, not the constructor argument: the point is
    // that the mocked engine actually ran, not that we can read back a literal.
    const service = new gcp.cloudrunv2.Service("smoke-ingress", {
      location: "europe-west1",
      ingress: "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
      template: {
        containers: [{ image: "europe-west1-docker.pkg.dev/p/r/api:v1" }],
      },
    });
    await expect(resolve(service.ingress)).resolves.toBe(
      "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
    );
  });

  it("needs no GOOGLE_APPLICATION_CREDENTIALS", () => {
    expect(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? "").toBe("");
  });
});
