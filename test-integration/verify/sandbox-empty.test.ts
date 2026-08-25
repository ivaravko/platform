import { describe, expect, it } from "vitest";
import {
  listServiceAccountEmails,
  listServiceNames,
} from "../support/gcp-client";
import { SANDBOX_PROJECT_ID, assertSandbox } from "../support/sandbox";
import { FIXTURE_ACCOUNT_PREFIX } from "../support/stack";

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

/** Long enough for the retry below, plus slack. */
const TIMEOUT_MS = 180_000;

/**
 * Polls until nothing is left, or gives up and reports what is.
 *
 * **Deletion is not immediately visible.** The first run of the service-account
 * check reported a leak that had in fact already been destroyed — GCP's IAM
 * listing had simply not caught up. A leak detector that fires on propagation
 * lag is worse than none: the failure is real-looking, unreproducible, and
 * trains everyone to rerun the job.
 *
 * So this is the one place the tier retries, and it retries a *specific*
 * condition — a resource that should be gone still being listed. Nothing else
 * is retried, because everything else failing twice means the same thing it
 * meant the first time.
 */
const untilEmpty = async (
  what: string,
  list: () => Promise<string[]>,
): Promise<string[]> => {
  const deadline = Date.now() + 120_000;
  let remaining = await list();

  while (remaining.length > 0 && Date.now() < deadline) {
    // Logged, not silent: a check that quietly took two minutes hides a
    // teardown that is getting slower until it eventually times out.
    console.log(
      `${what}: ${remaining.length} still listed, waiting for deletion to propagate`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    remaining = await list();
  }

  return remaining;
};

describe("the sandbox is empty", () => {
  it(
    "holds no Cloud Run services",
    async () => {
      const services = await untilEmpty("cloud run services", listServiceNames);

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

  it(
    "holds no fixture service accounts",
    async () => {
      // Filtered by prefix, not asserted empty: the sandbox legitimately holds
      // `runway-api` and the default compute account, and a check that demanded
      // an empty project would fail forever on resources it does not own.
      const leaked = await untilEmpty("fixture service accounts", async () =>
        (await listServiceAccountEmails()).filter((email) =>
          email.startsWith(FIXTURE_ACCOUNT_PREFIX),
        ),
      );

      expect(
        leaked,
        leaked.length === 0
          ? ""
          : `Leaked fixture service accounts in ${SANDBOX_PROJECT_ID}: ` +
              `${leaked.join(", ")}. Remove with: gcloud iam service-accounts ` +
              `delete <email> --project ${SANDBOX_PROJECT_ID}`,
      ).toEqual([]);
    },
    TIMEOUT_MS,
  );
});
