import * as pulumi from "@pulumi/pulumi";

/**
 * Shared Pulumi test harness.
 *
 * `setMocks` replaces the engine, so constructing a resource performs no network
 * call and needs no credentials.
 *
 * The `void` is deliberate, not a silenced lint warning. `setMocks` is declared
 * `async` and so returns `Promise<void>`, but its body contains no `await` —
 * it installs the mock monitor and sets feature flags synchronously
 * (`@pulumi/pulumi/runtime/mocks.js`), so the promise is already resolved on
 * return and mocks are in place before this module finishes evaluating. If a
 * future Pulumi release makes that body genuinely asynchronous, this becomes a
 * real race and the fix is to export the promise and await it in `beforeAll`.
 */
void pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs) => ({
    id: `${args.name}_id`,
    // Provider-computed outputs the mock must stand in for: with only `inputs`,
    // anything the real provider derives (a Cloud Run service's uri) resolves to
    // undefined and assertions on it would pass for the wrong reason.
    state:
      args.type === "gcp:cloudrunv2/service:Service"
        ? { ...args.inputs, uri: `https://${args.name}-mocked-ew.a.run.app` }
        : args.inputs,
  }),
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

/**
 * Resolves an Output to its value.
 *
 * Success only. `apply` has no rejection path, so a failing Output leaves this
 * promise pending and the test times out instead of failing usefully. Asserting
 * on a *failing* Output is not possible here at all — see the note on
 * `secure-container-service.test.ts` about unhandled rejections.
 */
export const resolve = <T>(output: pulumi.Output<T>): Promise<T> =>
  new Promise((res) => output.apply(res));
