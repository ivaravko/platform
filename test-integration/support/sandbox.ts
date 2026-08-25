/**
 * The one check standing between an unattended `pulumi up` and a real project.
 *
 * SPEC.md's Never list permits unattended `up`/`destroy` from exactly one
 * workflow against exactly one project. That exception is only as narrow as
 * this file makes it, so the check is a pure function over an environment —
 * no I/O, no credentials — and it is exercised by `test/integration-guard.test.ts`
 * in the pull-request gate rather than only in the tier it protects.
 *
 * See SPEC-integration-tests.md and SPEC.md open question 3.
 */

/**
 * The designated sandbox. Deliberately the only place this id is written: a
 * second copy is a second thing to update when the sandbox moves, and the one
 * that gets missed is the one that deploys somewhere unintended.
 */
export const SANDBOX_PROJECT_ID = "enduring-badge-506610-u9";

/** The sandbox's project *number*, for API responses that report it that way. */
export const SANDBOX_PROJECT_NUMBER = "741165637912";

/** The region the manual verification ran in; fixtures stay consistent with it. */
export const SANDBOX_REGION = "europe-west1";

/**
 * Refusal to run, as distinct from a failed assertion.
 *
 * Its own type so a test can assert that the *guard* rejected rather than that
 * something happened to throw — an `expect(...).toThrow()` with no type passes
 * just as readily on a typo in the module under test.
 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** The environment shape this reads, narrowed to what it actually uses. */
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Returns the sandbox project id, or throws if the environment names anything
 * else.
 *
 * Three deliberate refusals, each removing a class of accident:
 *
 *   - **Unset does not default to the sandbox.** Defaulting would make an
 *     unconfigured machine deploy somewhere. Refusing costs one environment
 *     variable.
 *   - **No trimming.** A value with stray whitespace is a malformed variable,
 *     and quietly repairing it hides the defect until the day it repairs
 *     something else.
 *   - **Case-sensitive.** GCP project ids are, so a case-insensitive match here
 *     would accept an id that Google would not resolve.
 */
export const resolveSandboxProject = (env: Environment): string => {
  const configured = env.GOOGLE_CLOUD_PROJECT;

  if (configured === undefined || configured.trim() === "") {
    throw new SandboxError(
      "Integration tests need GOOGLE_CLOUD_PROJECT set to the designated " +
        `sandbox ${SANDBOX_PROJECT_ID}, and it is unset. It is not defaulted: ` +
        "an unconfigured machine must not deploy anywhere.",
    );
  }

  if (configured !== SANDBOX_PROJECT_ID) {
    throw new SandboxError(
      `Integration tests refuse to run against ${JSON.stringify(configured)}. ` +
        `The only permitted project is ${SANDBOX_PROJECT_ID}. ` +
        "SPEC.md permits unattended pulumi up against that project and no other.",
    );
  }

  return configured;
};

/**
 * Module-scope guard for an integration test file.
 *
 * Called at import time, not inside a test, so a misconfigured environment
 * fails before any resource is planned rather than midway through a deploy
 * that then needs manual cleanup.
 */
export const assertSandbox = (env: Environment = process.env): string =>
  resolveSandboxProject(env);
