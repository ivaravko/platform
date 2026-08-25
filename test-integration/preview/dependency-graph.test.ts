import { describe, expect, it } from "vitest";
import { isolatedPolicyPack } from "../support/policy-pack";
import { assertSandbox } from "../support/sandbox";
import { withFixtureStack } from "../support/stack";

/**
 * CR-03's stack-scoped rule, against a dependency graph the engine actually built.
 *
 * This closes a gap `docs/control-mapping.md` records by name. The rule resolves
 * an `allUsers` invoker binding to the service it targets, and it must do so
 * through the engine's dependency edges: a Cloud Run service's name is
 * provider-generated, so a stack that lets Pulumi auto-name has no literal
 * string to match on. `pulumi.runtime.setMocks()` supplies no edges, which is
 * why `stack-compliance.test.ts` excludes this rule outright — run over mocked
 * output it reports violations on compliant stacks.
 *
 * Two fixtures, because one direction proves nothing on its own:
 *
 *   - **public-service** grants `allUsers` *and* records a justification. It
 *     must pass. A pass proves the edge resolved — if resolution failed, the
 *     rule treats the binding as unjustified and fires.
 *   - **rogue-public** bypasses the component with raw resources and no
 *     justification. It must fail. Without this, a rule that resolved nothing
 *     and passed everything would look identical to a working one.
 */

assertSandbox();

const PREVIEW_TIMEOUT_MS = 300_000;

/** The rule's own words, so a reworded message fails loudly rather than silently. */
const CR03_VIOLATION = /grants allUsers the roles\/run\.invoker role/;

describe("CR-03: the stack-scoped rule against a real engine graph", () => {
  it(
    "CR-03: passes a justified public service, resolving the binding by dependency edge",
    async () => {
      const output = await withFixtureStack(
        { fixture: "public-service", stackName: "cr03-justified" },
        async (stack) => {
          const result = await stack.preview({
            policyPacks: [isolatedPolicyPack()],
          });
          return result.stdout;
        },
      );

      // The pack ran. Without this the test would pass just as happily if the
      // pack silently failed to load, which is the exact failure this tier had
      // to solve for.
      expect(output).toMatch(/runway-gcp/);
      expect(output).not.toMatch(CR03_VIOLATION);
    },
    PREVIEW_TIMEOUT_MS,
  );

  it(
    "CR-03: fails a raw allUsers binding that records no justification",
    async () => {
      const failure = await withFixtureStack(
        { fixture: "rogue-public", stackName: "cr03-rogue" },
        async (stack) => {
          try {
            await stack.preview({ policyPacks: [isolatedPolicyPack()] });
            return undefined;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      );

      // Not `.toThrow()`: a preview can fail for many reasons, and this must
      // fail for *this* one. An unrelated crash would otherwise read as the
      // guardrail working.
      expect(failure).toBeDefined();
      expect(failure).toMatch(CR03_VIOLATION);
    },
    PREVIEW_TIMEOUT_MS,
  );
});
