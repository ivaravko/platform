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

  /** Runtime identity. Must be user-managed — CR-04 rejects a default SA. */
  readonly serviceAccountEmail?: string;
}

/**
 * Google's own sample image. Using it keeps the tier independent of a build:
 * no Artifact Registry push is needed to exercise the Cloud Run controls.
 */
const SAMPLE_IMAGE = "gcr.io/cloudrun/hello";

const RUNTIME_SERVICE_ACCOUNT = `runway-api@${SANDBOX_PROJECT_ID}.iam.gserviceaccount.com`;

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
      [`${project}:serviceAccountEmail`]: {
        value: options.serviceAccountEmail ?? RUNTIME_SERVICE_ACCOUNT,
      },
    });

    return await body(stack);
  } finally {
    // force: the stack is ours, made moments ago, and nothing else may hold it.
    await stack.workspace.removeStack(options.stackName, { force: true });
    rmSync(settingsFile, { force: true });
  }
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
