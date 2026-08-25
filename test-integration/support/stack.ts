import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  type EngineEvent,
  LocalWorkspace,
  type Stack,
} from "@pulumi/pulumi/automation";
import {
  SANDBOX_PROJECT_ID,
  SANDBOX_REGION,
  assertSandbox,
} from "./sandbox";

/**
 * Stack lifecycle for the integration tier, via the Automation API.
 *
 * **Stack config lives here, in code, not in a committed `Pulumi.<stack>.yaml`.**
 * Two reasons, both found by trying the alternative:
 *
 *   - Pulumi rewrites `encryptionsalt` into that file on every run, keyed to
 *     whatever passphrase was used. Committing it pins the repo to one fixed
 *     passphrase; not committing it leaves the working tree permanently dirty.
 *     Setting config programmatically sidesteps both — the file becomes a pure
 *     artifact and is gitignored.
 *   - It put the sandbox project id in two places. `sandbox.ts` says the id
 *     appears exactly once, and a second copy is the one that gets missed when
 *     the sandbox moves.
 */

/** Where the compiled fixture programs and their `Pulumi.yaml` files live. */
const FIXTURES = join(__dirname, "..", "fixtures");

/**
 * A per-run passphrase.
 *
 * No fixture stores a secret, so this encrypts nothing and never needs to be
 * recovered — which is exactly why it can be thrown away. A fixed passphrase
 * would have to live somewhere: committed (a credential-shaped string in a repo
 * whose subject is credential hygiene) or in a CI secret (one more thing to
 * rotate). Neither buys anything when there is no secret to protect.
 */
const throwawayPassphrase = (): string => randomBytes(24).toString("hex");

export interface FixtureStackOptions {
  /** Directory name under `fixtures/`, e.g. `private-service`. */
  readonly fixture: string;

  /** Stack name. Distinct per test file, so concurrent runs cannot collide. */
  readonly stackName: string;

  /** Container image. Defaults to Google's always-available sample. */
  readonly image?: string;
}

/**
 * Google's own sample image. Using it keeps the tier independent of a build:
 * no Artifact Registry push is needed to exercise the Cloud Run controls.
 */
const SAMPLE_IMAGE = "gcr.io/cloudrun/hello";

/**
 * A fresh service-account id per run, sharing one recognisable prefix.
 *
 * Fixtures build their own `SecureServiceAccount` since D4, so each run creates
 * a real IAM identity and must remove it. Unique rather than stable because GCP
 * reserves a deleted account's id for 30 days, and reusing one lands in
 * resurrection semantics rather than a clean create.
 *
 * The shared prefix is what lets the emptiness check tell a leaked fixture
 * identity from the sandbox's pre-existing accounts. Kept well inside GCP's
 * 30-character limit.
 */
export const FIXTURE_ACCOUNT_PREFIX = "int-fx-";

const fixtureAccountId = (): string =>
  `${FIXTURE_ACCOUNT_PREFIX}${randomBytes(5).toString("hex")}`;

/**
 * Runs `body` against a fixture stack that exists only for the call.
 *
 * **The stack is ephemeral because the passphrase is.** A throwaway passphrase
 * and a persisted stack are incompatible: Pulumi writes `encryptionsalt` into
 * `Pulumi.<stack>.yaml` keyed to the passphrase that created the stack, so the
 * next run generates a different passphrase and the CLI fails with
 * `incorrect passphrase`. Found by running the tier twice — the first run
 * passed, which is exactly how this would have reached CI.
 *
 * So the stack is created, used, and removed within one call. That also makes
 * "plans three creates and nothing else" a meaningful assertion: leftover state
 * would turn creates into updates, and an unchanged resource carries no inputs
 * to check.
 *
 * `gcp:project` is set explicitly and never inherited. Without it the provider
 * falls back to gcloud's active project, which on a developer machine is
 * whatever they last worked on — on the machine this was written, a project
 * holding live workloads.
 *
 * **Tier B note:** this removes stack *state*, which is not the same as
 * destroying cloud resources. A body that runs `up` must `destroy` before
 * returning, or the removal orphans whatever it created. T7 owns that.
 */
export const withFixtureStack = async <T>(
  options: FixtureStackOptions,
  body: (stack: Stack) => Promise<T>,
): Promise<T> => {
  // Throws before the workspace is even constructed if the environment names
  // anything but the sandbox.
  assertSandbox();

  const workDir = join(FIXTURES, options.fixture);
  const settingsFile = join(workDir, `Pulumi.${options.stackName}.yaml`);

  // A crashed run leaves this behind, salted for a passphrase that no longer
  // exists anywhere. Removing it up front turns a permanently wedged fixture
  // into a self-healing one.
  rmSync(settingsFile, { force: true });

  const stack = await LocalWorkspace.createOrSelectStack(
    { stackName: options.stackName, workDir },
    { envVars: { PULUMI_CONFIG_PASSPHRASE: throwawayPassphrase() } },
  );

  try {
    const project = (await stack.workspace.projectSettings()).name;
    await stack.setAllConfig({
      "gcp:project": { value: SANDBOX_PROJECT_ID },
      "gcp:region": { value: SANDBOX_REGION },
      [`${project}:location`]: { value: SANDBOX_REGION },
      [`${project}:image`]: { value: options.image ?? SAMPLE_IMAGE },
      [`${project}:accountId`]: { value: fixtureAccountId() },
    });

    return await body(stack);
  } finally {
    // force: the stack is ours, made moments ago, and nothing else may hold it.
    await stack.workspace.removeStack(options.stackName, { force: true });
    rmSync(settingsFile, { force: true });
  }
};


/** What a deployed stack exposes to its assertions. */
export interface Deployment {
  /** Stack outputs, as Pulumi recorded them — the "what we asked for" side. */
  readonly outputs: Readonly<Record<string, unknown>>;
}

/**
 * Deploys a fixture, runs `body` against it, and destroys it — always.
 *
 * **Destroy is in a `finally` and its result is asserted, not swallowed.** A
 * leaked Cloud Run service in a sandbox costs pennies; a teardown that silently
 * stopped working is how the sandbox stops being a sandbox. If `destroy` fails
 * the call throws, even when the body succeeded, because a green test over a
 * project that is quietly filling up is the worse outcome.
 *
 * If the body *also* threw, the body's error wins and the teardown failure is
 * attached to it. Replacing a real assertion failure with a cleanup error would
 * hide the finding behind the janitorial problem.
 *
 * Ordering matters: `destroy` removes the cloud resources, and only then does
 * `withFixtureStack` remove the stack state. Reversed, the state that names
 * what to destroy would be gone first and the resources orphaned.
 */
export const withDeployedStack = async <T>(
  options: FixtureStackOptions,
  body: (deployment: Deployment) => Promise<T>,
): Promise<T> =>
  withFixtureStack(options, async (stack) => {
    // A tagged outcome rather than `T | undefined`. The latter needs a cast to
    // return, and the lint gate rejects casting a generic — rightly: `undefined`
    // may be a perfectly good `T`, so the cast would paper over a body that
    // never ran rather than reporting it.
    let outcome: { readonly ok: true; readonly value: T } | {
      readonly ok: false;
      readonly error: unknown;
    } = { ok: false, error: new Error("the deployment body never ran") };
    let teardownError: unknown;

    try {
      const up = await stack.up();
      const outputs = Object.fromEntries(
        Object.entries(up.outputs).map(([key, output]) => [key, output.value]),
      );
      outcome = { ok: true, value: await body({ outputs }) };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      try {
        await releaseAndDestroy(stack);
      } catch (error) {
        teardownError = error;
      }
    }

    // Errors are recorded and rethrown out here rather than from the `finally`.
    // A `throw` inside `finally` replaces whatever the body was already
    // throwing, so a teardown failure would silently swallow the assertion
    // failure that caused it — the lint gate names this `no-unsafe-finally`.
    //
    // Body first: if both failed, the assertion is the finding and the orphaned
    // resource is a consequence of it.
    if (!outcome.ok) {
      throw outcome.error;
    }
    // Still fatal on its own. A leaked service costs pennies; a teardown that
    // quietly stopped working is how the sandbox stops being a sandbox.
    if (teardownError !== undefined) {
      throw teardownError;
    }

    return outcome.value;
  });

/**
 * Two-phase teardown: release deletion protection, then destroy.
 *
 * CR-06 defaults protection on and the provider then refuses —
 * `cannot destroy service without setting deletion_protection=false`. So an
 * automated tier cannot deploy a protected service and simply destroy it.
 *
 * Found the hard way. The first Tier B run left a real Cloud Run service
 * behind, and removing it needed `gcloud run services delete` — which worked
 * precisely because CR-06 guards the IaC path only, the control's own
 * documented gap.
 *
 * The release happens here and nowhere else, so every assertion in the body ran
 * against a genuinely protected service.
 */
const releaseAndDestroy = async (stack: Stack): Promise<void> => {
  const project = (await stack.workspace.projectSettings()).name;
  await stack.setConfig(`${project}:releaseDeletionProtection`, {
    value: "true",
  });
  await stack.up();
  await stack.destroy();
};

/**
 * Every resource the engine planned, as the provider received it.
 *
 * `preview` returns only a change summary, which counts operations and says
 * nothing about what was sent. The engine event stream carries the actual
 * inputs, and those inputs are the contract this tier exists to check.
 */
export interface PlannedResource {
  readonly type: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

/** Collects planned resources from an engine event stream. */
export const collectPlanned = (
  into: PlannedResource[],
): ((event: EngineEvent) => void) => {
  return (event: EngineEvent): void => {
    const pre = event.resourcePreEvent;
    if (pre === undefined) {
      return;
    }
    into.push({
      type: pre.metadata.type,
      inputs: (pre.metadata.new?.inputs ?? {}) as Record<string, unknown>,
    });
  };
};

/**
 * A type predicate, deliberately not a cast.
 *
 * Resource inputs arrive as `unknown` and the interesting values are nested
 * inside them. A cast would tell the compiler what to believe; this checks. The
 * lint gate rejects the cast form (`no-unsafe-type-assertion`), and it is right
 * to — a mis-shaped input is exactly what this tier exists to catch, so quietly
 * asserting the shape would defeat the test.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Reads a nested string out of resource inputs, or `undefined`.
 *
 * Returns `undefined` for every failure — missing key, wrong type, non-object
 * along the path — so an assertion reads as "the provider was sent this value"
 * rather than throwing on the shape before it can report the value.
 */
export const stringAt = (
  inputs: Readonly<Record<string, unknown>>,
  ...path: readonly string[]
): string | undefined => {
  let current: unknown = inputs;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
};

/** The one planned resource of a given type; fails loudly if it is not unique. */
export const onlyResourceOfType = (
  planned: readonly PlannedResource[],
  type: string,
): PlannedResource => {
  const matches = planned.filter((resource) => resource.type === type);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one ${type} in the plan, found ${matches.length}. ` +
        `Planned types: ${planned.map((r) => r.type).join(", ")}`,
    );
  }
  return matches[0];
};
