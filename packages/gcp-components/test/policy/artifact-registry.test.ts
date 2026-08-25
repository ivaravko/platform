import { describe, expect, it, vi } from "vitest";
import {
  checkCleanupNotDryRun,
  checkImmutableTags,
  checkVulnerabilityScanning,
  type RepositoryProps,
} from "../../src/policy/artifact-registry-rules";

const report = () => vi.fn<(message: string, urn?: string) => void>();
const docker = (extra: Partial<RepositoryProps> = {}): RepositoryProps => ({
  format: "DOCKER",
  dockerConfig: { immutableTags: true },
  ...extra,
});

describe("AR-01: raw Docker repositories must freeze their tags", () => {
  it("passes a repository with immutable tags", () => {
    const r = report();
    checkImmutableTags(docker(), r);
    expect(r).not.toHaveBeenCalled();
  });

  it.each([
    ["dockerConfig absent", { dockerConfig: undefined }],
    ["immutableTags false", { dockerConfig: { immutableTags: false } }],
    ["immutableTags absent", { dockerConfig: {} }],
  ])("rejects %s", (_label, extra) => {
    const r = report();
    checkImmutableTags(docker(extra), r);
    expect(r).toHaveBeenCalledOnce();
  });

  it("ignores non-Docker repositories rather than firing falsely", () => {
    // dockerConfig is meaningless on a Maven repository. A rule that fires
    // where it cannot apply is a rule that gets switched off.
    const r = report();
    checkImmutableTags({ format: "MAVEN" }, r);
    expect(r).not.toHaveBeenCalled();
  });
});

describe("AR-02: scanning must not be disabled", () => {
  it("passes INHERITED", () => {
    const r = report();
    checkVulnerabilityScanning(docker({ vulnerabilityScanningConfig: { enablementConfig: "INHERITED" } }), r);
    expect(r).not.toHaveBeenCalled();
  });

  it("passes when the block is absent, which means the project default", () => {
    const r = report();
    checkVulnerabilityScanning(docker(), r);
    expect(r).not.toHaveBeenCalled();
  });

  it("rejects DISABLED", () => {
    const r = report();
    checkVulnerabilityScanning(docker({ vulnerabilityScanningConfig: { enablementConfig: "DISABLED" } }), r);
    expect(r).toHaveBeenCalledOnce();
  });
});

describe("AR-03: retention must actually delete", () => {
  it("passes when dry-run is not set", () => {
    const r = report();
    checkCleanupNotDryRun(docker(), r);
    expect(r).not.toHaveBeenCalled();
  });

  it("rejects dry-run, which retains everything while looking configured", () => {
    const r = report();
    checkCleanupNotDryRun(docker({ cleanupPolicyDryRun: true }), r);
    expect(r).toHaveBeenCalledOnce();
  });
});
