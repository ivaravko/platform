import { describe, expect, it } from "vitest";
import { listServiceNames } from "../support/gcp-client";
import { SANDBOX_PROJECT_ID, assertSandbox } from "../support/sandbox";

/**
 * The sandbox holds nothing once the tiers have run.
 *
 * Every deploy test destroys what it created, so this should be redundant —
 * and that is exactly why it exists. Teardown failing silently is the one
 * failure the deploy tests cannot report on themselves: a test that has already
 * passed its assertions and then leaks is still green.
 *
 * **Runs in its own task, after the others.** vitest gives no ordering
 * guarantee across files, so sharing a run with tests that deploy would make
 * this pass or fail on scheduling. A leak detector that is racy is worse than
 * none, because a green run stops meaning anything.
 *
 * It also catches leaks from *previous* runs — a crash between `up` and
 * `destroy` leaves a service behind, and the next night's run reports it.
 * That is the intended backstop: the failure surfaces here rather than in a
 * billing alert.
 */

assertSandbox();

/** One API call, but against a real endpoint. */
const TIMEOUT_MS = 60_000;

describe("the sandbox is empty", () => {
  it(
    "holds no Cloud Run services",
    async () => {
      const services = await listServiceNames();

      // The message carries the names and the remedy: whoever reads this failure
      // is looking at a bill, not at this file.
      expect(
        services,
        services.length === 0
          ? ""
          : `Leaked Cloud Run services in ${SANDBOX_PROJECT_ID}: ` +
              `${services.join(", ")}. Remove with: gcloud run services delete ` +
              `<name> --project ${SANDBOX_PROJECT_ID} --region europe-west1 — ` +
              "which works even on a deletion-protected service, since CR-06 " +
              "guards the IaC path only.",
      ).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
