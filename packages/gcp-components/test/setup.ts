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
    state: args.inputs,
  }),
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

/** Resolves an Output to its value. Outputs are not promises; they need apply. */
export const resolve = <T>(output: pulumi.Output<T>): Promise<T> =>
  new Promise((res) => output.apply(res));
