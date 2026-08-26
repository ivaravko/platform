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
const IAM_API = "https://iam.googleapis.com/v1";

const servicePath = (name: string): string =>
  `projects/${SANDBOX_PROJECT_ID}/locations/${SANDBOX_REGION}/services/${name}`;

/**
 * GETs a Cloud Run API path.
 *
 * A non-200 throws with the body attached. The alternative — returning
 * `undefined` on failure — makes "the service is not public" and "the request
 * was rejected" the same answer, and the second must never read as the first.
 */
const get = async (path: string, base: string = RUN_API): Promise<unknown> => {
  assertSandbox();

  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const response = await fetch(`${base}/${path}`, {
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

/**
 * Every service account in the sandbox, by email.
 *
 * A leaked identity is a different failure from a leaked service and needs its
 * own read: fixtures build their own `SecureServiceAccount` since D4, and the
 * Cloud Run listing cannot see one. It is also the quieter leak — an orphaned
 * account costs nothing, so nothing else would ever surface it.
 */
export const listServiceAccountEmails = async (): Promise<string[]> => {
  const path = `projects/${SANDBOX_PROJECT_ID}/serviceAccounts`;
  const response = asObject(await get(path, IAM_API), path);
  const accounts = Array.isArray(response.accounts) ? response.accounts : [];

  return accounts
    .map((account: unknown) =>
      typeof account === "object" && account !== null && "email" in account
        ? account.email
        : undefined,
    )
    .filter((email): email is string => typeof email === "string");
};

const CRM_API = "https://cloudresourcemanager.googleapis.com/v1";

/**
 * POSTs an API path with an empty body — `getIamPolicy` is a POST in the
 * Resource Manager API, oddly but officially. Same failure stance as `get`:
 * a non-200 throws with the body attached, because "the project has no
 * policy" and "the request was rejected" must never be the same answer.
 */
const post = async (path: string, base: string): Promise<unknown> => {
  assertSandbox();

  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const response = await fetch(`${base}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token.token ?? ""}`,
      "content-type": "application/json",
    },
    body: "{}",
  });

  if (!response.ok) {
    throw new Error(
      `POST ${path} returned ${response.status}: ${await response.text()}`,
    );
  }

  return await response.json();
};

/**
 * The sandbox project's own IAM policy, exactly as Google reports it.
 *
 * This is EP-06's raw material: the live bindings, unnormalised, so the audit
 * judges what a real adoption would judge rather than a fixture's idea of it.
 */
export const getProjectIamPolicy = async (): Promise<IamPolicy> => {
  const path = `projects/${SANDBOX_PROJECT_ID}:getIamPolicy`;
  const policy = asObject(await post(path, CRM_API), path);
  const bindings = policy.bindings;
  return { bindings: Array.isArray(bindings) ? bindings : undefined };
};

/**
 * A custom role's granted permissions, from its live definition.
 *
 * The audit refuses to guess about a custom role a human holds; this is how
 * the tier answers instead of guessing. Predefined roles never come through
 * here — the audit resolves those from its stated table.
 */
export const getCustomRolePermissions = async (
  role: string,
): Promise<readonly string[]> => {
  const definition = asObject(await get(role, IAM_API), role);
  const permissions = definition.includedPermissions;
  return Array.isArray(permissions)
    ? permissions.filter((p): p is string => typeof p === "string")
    : [];
};
