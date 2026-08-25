import { GoogleAuth } from "google-auth-library";
import { SANDBOX_PROJECT_ID, SANDBOX_REGION, assertSandbox } from "./sandbox";

/**
 * Reads deployed state back from Google, as Google reports it.
 *
 * **This module deliberately cannot see Pulumi state.** Pulumi state records
 * what we asked for; the API reports what GCP did. CR-06 is the standing proof
 * that these differ — state says `deletionProtection: true` and the v2 API
 * returns `null` — so a harness that read state would have reported that
 * control as verified, and the divergence would still be unknown.
 *
 * Responses are returned **unnormalised**. No defaulting, no camel-casing, no
 * filling in absent fields: `deletionProtection: null` must survive as `null`,
 * because the null *is* the finding. A convenience layer that tidied it into
 * `false`, or dropped it as empty, would erase the one reading this tier exists
 * to take.
 */

const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

/** A Cloud Run v2 service, exactly as the API returned it. */
export type ServiceResponse = Readonly<Record<string, unknown>>;

/** An IAM policy binding, exactly as the API returned it. */
export interface IamPolicy {
  readonly bindings?: readonly {
    readonly role?: string;
    readonly members?: readonly string[];
  }[];
}

const RUN_API = "https://run.googleapis.com/v2";

const servicePath = (name: string): string =>
  `projects/${SANDBOX_PROJECT_ID}/locations/${SANDBOX_REGION}/services/${name}`;

/**
 * GETs a Cloud Run API path.
 *
 * A non-200 throws with the body attached. The alternative — returning
 * `undefined` on failure — makes "the service is not public" and "the request
 * was rejected" the same answer, and the second must never read as the first.
 */
const get = async (path: string): Promise<unknown> => {
  assertSandbox();

  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const response = await fetch(`${RUN_API}/${path}`, {
    headers: { authorization: `Bearer ${token.token ?? ""}` },
  });

  if (!response.ok) {
    throw new Error(
      `GET ${path} returned ${response.status}: ${await response.text()}`,
    );
  }

  return await response.json();
};

/**
 * Narrows a response to an object, rather than asserting it is one.
 *
 * The lint gate rejects `as T` here and is right to: a generic cast tells the
 * compiler to believe whatever the caller asked for, and this module's whole
 * purpose is to report what Google actually sent. A check that fails loudly on
 * a surprising response is the point, not an obstacle to it.
 */
const asObject = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`GET ${path} returned ${typeof value}, expected an object.`);
  }
  return { ...value };
};

/** The deployed service, or throws if Google will not return it. */
export const getService = async (name: string): Promise<ServiceResponse> => {
  const path = servicePath(name);
  return asObject(await get(path), path);
};

/**
 * The service's IAM policy.
 *
 * Separate from the service resource because Cloud Run keeps them separate: a
 * service's `allUsers` invoker grant is not a field on the service, and reading
 * only the service would report every deployment as private.
 */
export const getServiceIamPolicy = async (name: string): Promise<IamPolicy> => {
  const path = `${servicePath(name)}:getIamPolicy`;
  const policy = asObject(await get(path), path);
  const bindings = policy.bindings;
  return { bindings: Array.isArray(bindings) ? bindings : undefined };
};

/** Every Cloud Run service in the sandbox region, by name. */
export const listServiceNames = async (): Promise<string[]> => {
  const path = `projects/${SANDBOX_PROJECT_ID}/locations/${SANDBOX_REGION}/services`;
  const response = asObject(await get(path), path);
  const services = Array.isArray(response.services) ? response.services : [];

  return services
    .map((service: unknown) =>
      typeof service === "object" && service !== null && "name" in service
        ? service.name
        : undefined,
    )
    .filter((name): name is string => typeof name === "string")
    // The API returns fully-qualified paths; the short name is what a test names.
    .map((name) => name.slice(name.lastIndexOf("/") + 1));
};
