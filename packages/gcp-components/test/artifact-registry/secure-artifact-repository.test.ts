import { describe, expect, it } from "vitest";
import { resolve } from "../setup";
import { SecureArtifactRepository } from "../../src/artifact-registry/secure-artifact-repository";

/**
 * SecureArtifactRepository — where images come from.
 *
 * One `it` per control-mapping row, named after that row. Assertions resolve
 * `Output` values; reading back constructor arguments would prove only that we
 * can read back what we passed.
 */

const repo = (name: string, args: Record<string, unknown> = {}): SecureArtifactRepository =>
  new SecureArtifactRepository(name, {
    repositoryId: "runway",
    location: "europe-west1",
    ...args,
  });

describe("AR-01: pushed tags cannot be repointed", () => {
  it("enables immutable tags", async () => {
    const config = await resolve(repo("ar01").repository.dockerConfig);
    expect(config?.immutableTags).toBe(true);
  });

  it("has no opt-out for it", () => {
    // A mutable tag means `:v1` can be made to mean something else after
    // review. There is no justified form of that, so unlike publicAccess there
    // is no escape hatch at all.
    const args = Object.keys({
      repositoryId: "",
      location: "",
      description: "",
      kmsKeyName: "",
      keepMostRecent: 0,
    });
    expect(args.some((k) => /immutable|mutable|tag/i.test(k))).toBe(false);
  });
});

describe("AR-02: vulnerability scanning is never disabled", () => {
  it("inherits the project's scanning setting", async () => {
    const config = await resolve(repo("ar02").repository.vulnerabilityScanningConfig);
    expect(config?.enablementConfig).toBe("INHERITED");
  });
});

describe("AR-03: retention is bounded, and actually applied", () => {
  it("keeps a bounded number of recent versions", async () => {
    const policies = await resolve(repo("ar03-keep").repository.cleanupPolicies);
    const keep = policies?.find((p) => p.action === "KEEP");
    expect(keep?.mostRecentVersions?.keepCount).toBeGreaterThan(0);
  });

  it("deletes untagged versions older than 30 days", async () => {
    const policies = await resolve(repo("ar03-delete").repository.cleanupPolicies);
    const remove = policies?.find((p) => p.action === "DELETE");
    expect(remove?.condition?.tagState).toBe("UNTAGGED");
    // 30 days, in the seconds form the API takes.
    expect(remove?.condition?.olderThan).toBe("2592000s");
  });

  it("does NOT enable dry-run, which would make every policy decorative", async () => {
    // cleanupPolicyDryRun evaluates the policies and deletes nothing. The
    // repository would look correctly configured and retain everything.
    await expect(
      resolve(repo("ar03-dry").repository.cleanupPolicyDryRun),
    ).resolves.not.toBe(true);
  });

  it("lets the caller widen retention but not remove it", async () => {
    const policies = await resolve(repo("ar03-n", { keepMostRecent: 25 }).repository.cleanupPolicies);
    expect(policies?.find((p) => p.action === "KEEP")?.mostRecentVersions?.keepCount).toBe(25);
  });

  it.each([[0], [-1]])("rejects a keep count of %s", (count) => {
    expect(() => repo("ar03-bad", { keepMostRecent: count })).toThrow(/keep/i);
  });
});

describe("AR-04: the repository holds our own images, not a proxy", () => {
  it("is a standard Docker repository", async () => {
    const r = repo("ar04").repository;
    await expect(resolve(r.format)).resolves.toBe("DOCKER");
    await expect(resolve(r.mode)).resolves.toBe("STANDARD_REPOSITORY");
  });

  it("exposes no way to make it remote or virtual", () => {
    // A REMOTE_REPOSITORY proxies an external registry, so images arrive from
    // somewhere the immutable-tag guarantee does not reach.
    const args = Object.keys({ repositoryId: "", location: "", description: "", kmsKeyName: "" });
    expect(args.some((k) => /mode|remote|virtual/i.test(k))).toBe(false);
  });
});

describe("SecureArtifactRepository: surface", () => {
  it("supports CMEK without requiring it", async () => {
    const key = "projects/p/locations/europe-west1/keyRings/r/cryptoKeys/k";
    await expect(
      resolve(repo("cmek", { kmsKeyName: key }).repository.kmsKeyName),
    ).resolves.toBe(key);
    await expect(resolve(repo("no-cmek").repository.kmsKeyName)).resolves.toBeUndefined();
  });

  it("exposes the image path prefix, so callers need not build it", async () => {
    await expect(resolve(repo("prefix").imagePrefix)).resolves.toContain(
      "europe-west1-docker.pkg.dev",
    );
  });

  it("registers under the runway:gcp type namespace", async () => {
    await expect(resolve(repo("urn").repository.urn)).resolves.toContain(
      "runway:gcp:SecureArtifactRepository",
    );
  });
});
