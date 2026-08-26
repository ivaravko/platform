import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SANDBOX_PROJECT_ID, SANDBOX_REGION, assertSandbox } from "../support/sandbox";

/**
 * SPEC-release-path.md's Resolution tier: RP-03, against a real registry.
 *
 * The spec names RP-03 as **the control that will be skipped** — resolving a
 * missing tag returns an error that is easy to swallow, and the failure then
 * arrives as a Cloud Run revision that cannot pull its image, long after the
 * release looked successful. The static tier asserts the workflow's guard
 * exists; this tier proves the command underneath it actually behaves the way
 * the guard assumes: a missing tag exits non-zero and yields no digest, so
 * `release.yml`'s `test -n "$digest"` under bash -e stops the release before
 * any deploy step.
 *
 * The registry is created for the test and deleted in teardown — the same
 * arrange-reality role the deploy tier's fixtures play, done with gcloud
 * because nothing about a temporary test repository should look like shipped
 * infrastructure.
 *
 * **The positive half — a present tag resolving to its digest — is not here**,
 * recorded rather than implied: nothing can push an image until a generated
 * repo's CI has federation, so the first real resolution happens on the first
 * real release. This file proves the refusal; the release proves the rest.
 */

assertSandbox();

const REPO = `int-rp03-${randomBytes(4).toString("hex")}`;
const IMAGE = `${SANDBOX_REGION}-docker.pkg.dev/${SANDBOX_PROJECT_ID}/${REPO}/demo`;

const gcloud = (
  ...args: string[]
): { status: number; stdout: string; stderr: string } => {
  // spawnSync, not execFileSync: a non-zero exit is data here, not an
  // exception — the non-zero exit is the very thing under test.
  const result = spawnSync("gcloud", [...args, "--project", SANDBOX_PROJECT_ID], {
    encoding: "utf-8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

beforeAll(() => {
  const created = gcloud(
    "artifacts",
    "repositories",
    "create",
    REPO,
    "--repository-format=docker",
    `--location=${SANDBOX_REGION}`,
  );
  expect(created.status, created.stderr).toBe(0);
}, 120_000);

afterAll(() => {
  gcloud(
    "artifacts",
    "repositories",
    "delete",
    REPO,
    `--location=${SANDBOX_REGION}`,
    "--quiet",
  );
}, 120_000);

describe("RP-03 against a real registry", () => {
  it(
    "a tag absent from the registry fails the resolve step: non-zero, and no digest",
    { timeout: 120_000 },
    () => {
      // The exact command release.yml runs, against a tag no build pushed.
      const result = gcloud(
        "artifacts",
        "docker",
        "images",
        "describe",
        `${IMAGE}:sha-0000000000000000000000000000000000000000`,
        "--format=value(image_summary.digest)",
      );

      // Both halves of the gate: the exit code bash -e stops on, and the
      // empty output `test -n` refuses — either alone would fail the release
      // before a deploy step runs.
      expect(result.status).not.toBe(0);
      expect(result.stdout.trim()).toBe("");
    },
  );
});
