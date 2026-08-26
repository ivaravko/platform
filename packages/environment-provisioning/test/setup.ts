import * as pulumi from "@pulumi/pulumi";

/**
 * Pulumi test harness, mirroring gcp-components' test/setup.ts.
 *
 * `setMocks` replaces the engine, so constructing a resource performs no
 * network call and needs no credentials. The `void` is deliberate: setMocks
 * is declared async but installs the mock monitor synchronously, so mocks are
 * in place before this module finishes evaluating.
 */

/** One entry per resource the mocked engine was asked to create. */
export interface CreatedResource {
  readonly type: string;
  readonly name: string;
  /** The inputs the engine was handed, with Outputs already resolved. */
  readonly props: Record<string, unknown>;
}

/** Every resource created since the module loaded. Needed to assert absence —
 * inferring absence is how a missing resource passes for a correct one. */
export const createdResources: CreatedResource[] = [];

/**
 * Resources created by a component instance, matched on its Pulumi name.
 * Awaits pending registrations first: Pulumi registers asynchronously, and an
 * absence assertion against an empty registry passes for the wrong reason.
 */
export const resourcesFor = async (name: string): Promise<CreatedResource[]> => {
  await settled();
  return createdResources.filter((r) => r.name === name || r.name.startsWith(`${name}-`));
};

const settled = (): Promise<void> =>
  new Promise((res) => {
    setTimeout(res, 0);
  });

void pulumi.runtime.setMocks({
  newResource: (args: pulumi.runtime.MockResourceArgs) => ({
    id: (createdResources.push({
      type: args.type,
      name: args.name,
      props: args.inputs as Record<string, unknown>,
    }),
    `${args.name}_id`),
    state: { ...args.inputs, ...computedOutputs(args) },
  }),
  call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
});

/**
 * Provider-computed outputs the mock must stand in for, mirroring the shapes
 * the GCP provider actually returns. With only `args.inputs`, anything the
 * provider derives resolves to `undefined` — and an assertion on it would
 * pass for the wrong reason.
 */
const computedOutputs = (
  args: pulumi.runtime.MockResourceArgs,
): Record<string, unknown> => {
  const inputs = args.inputs as Record<string, unknown>;
  switch (args.type) {
    case "gcp:iam/workloadIdentityPool:WorkloadIdentityPool":
      // The full resource name, which principalSet members embed.
      return {
        name: `projects/000000000000/locations/global/workloadIdentityPools/${String(
          inputs.workloadIdentityPoolId,
        )}`,
      };
    case "gcp:serviceaccount/account:Account": {
      const email = `${String(inputs.accountId)}@${String(inputs.project)}.iam.gserviceaccount.com`;
      return {
        email,
        member: `serviceAccount:${email}`,
        name: `projects/${String(inputs.project)}/serviceAccounts/${email}`,
      };
    }
    default:
      return {};
  }
};

/**
 * Resolves an Output to its value. Success only: `apply` has no rejection
 * path, so a failing Output times the test out rather than failing usefully.
 */
export const resolve = <T>(output: pulumi.Output<T>): Promise<T> =>
  new Promise((res) => output.apply(res));
