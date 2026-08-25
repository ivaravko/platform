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
/** One entry per resource the mocked engine was asked to create. */
export interface CreatedResource {
  readonly type: string;
  readonly name: string;
}

/**
 * Every resource created since the module loaded.
 *
 * Needed to assert on resources a component creates but does not expose —
 * notably the `allUsers` invoker binding, where the claim under test is
 * "exactly one is emitted on the public path and none on the private path".
 * Without this, absence could only be inferred, and inferring absence is how
 * a missing resource passes for a correct one.
 */
export const createdResources: CreatedResource[] = [];

/**
 * Resources created by a component instance, matched on its Pulumi name.
 *
 * Awaits pending registrations first. Pulumi registers resources
 * asynchronously, so reading the registry straight after a constructor returns
 * sees an empty list — and an assertion that a resource is *absent* would pass
 * for the wrong reason, which is the failure mode this helper exists to prevent.
 */
export const resourcesFor = async (name: string): Promise<CreatedResource[]> => {
  await settled();
  return createdResources.filter((r) => r.name === name || r.name.startsWith(`${name}-`));
};

/** Lets queued microtasks and timers drain so registrations complete. */
const settled = (): Promise<void> =>
  new Promise((res) => {
    setTimeout(res, 0);
  });

void pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs) => ({
    id: (createdResources.push({ type: args.type, name: args.name }), `${args.name}_id`),
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
