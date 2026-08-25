import { describe, expect, it } from "vitest";
import {
  SANDBOX_PROJECT_ID,
  SandboxError,
  resolveSandboxProject,
} from "../test-integration/support/sandbox";

/**
 * The guard lives under `test-integration/`, which the root suite never
 * collects — but this test does not, and deliberately so.
 *
 * `resolveSandboxProject` is the single thing standing between a nightly
 * `pulumi up` and someone's production project. It is a pure function over an
 * environment, so it needs no credentials and no network, and there is no
 * reason for the one check that makes unattended deploys safe to run only in
 * the tier it protects. A broken guard must fail a pull request.
 */

describe("integration sandbox guard", () => {
  it("accepts the designated sandbox project", () => {
    expect(
      resolveSandboxProject({ GOOGLE_CLOUD_PROJECT: SANDBOX_PROJECT_ID }),
    ).toBe(SANDBOX_PROJECT_ID);
  });

  it("rejects any other project by name", () => {
    // The project that must never be used again: it holds live workloads and
    // service accounts. See SPEC.md open question 3.
    const live = "project-4da1a7fd-3681-4524-853";

    expect(() => resolveSandboxProject({ GOOGLE_CLOUD_PROJECT: live })).toThrow(
      SandboxError,
    );
    // The message names both what was found and what was required. A guard that
    // says only "wrong project" sends the reader to the source to learn which.
    expect(() => resolveSandboxProject({ GOOGLE_CLOUD_PROJECT: live })).toThrow(
      new RegExp(`${live}[\\s\\S]*${SANDBOX_PROJECT_ID}`),
    );
  });

  it("rejects an unset project rather than defaulting to the sandbox", () => {
    // Defaulting would make a machine with no configuration deploy somewhere.
    // Refusing costs one env var and removes a whole class of accident.
    expect(() => resolveSandboxProject({})).toThrow(SandboxError);
  });

  it("rejects an empty or whitespace-only project", () => {
    expect(() => resolveSandboxProject({ GOOGLE_CLOUD_PROJECT: "" })).toThrow(
      SandboxError,
    );
    expect(() => resolveSandboxProject({ GOOGLE_CLOUD_PROJECT: "   " })).toThrow(
      SandboxError,
    );
  });

  it("does not accept the sandbox id with surrounding whitespace", () => {
    // Trimming to a match would hide a malformed CI variable. The id either is
    // the sandbox or it is not.
    expect(() =>
      resolveSandboxProject({ GOOGLE_CLOUD_PROJECT: ` ${SANDBOX_PROJECT_ID} ` }),
    ).toThrow(SandboxError);
  });

  it("compares case-sensitively, as GCP project ids are", () => {
    expect(() =>
      resolveSandboxProject({
        GOOGLE_CLOUD_PROJECT: SANDBOX_PROJECT_ID.toUpperCase(),
      }),
    ).toThrow(SandboxError);
  });
});
