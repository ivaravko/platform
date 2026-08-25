import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RunwayServiceProject } from "../templates/runway-service-project";

/**
 * A problem with how the command was invoked, as opposed to a crash. The CLI
 * prints the message and exits non-zero; it never prints a stack trace for one.
 */
export class UsageError extends Error {}

/**
 * Lowercase alphanumerics and dashes, starting with an alphanumeric.
 *
 * Deliberately narrower than npm's own rules. It is the package name *and* the
 * directory name, so anything that could traverse (`..`, `/`, `\`) or resolve
 * somewhere unexpected is rejected outright rather than sanitised — a scaffolder
 * that silently rewrites a path the user typed is worse than one that refuses.
 */
export const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The name becomes a GCP project id, and that is the binding constraint.
 *
 * `environment-provisioning` adopts `<name>-staging` and `<name>-production`;
 * a project id caps at 30 characters, and `-production` costs 11 of them. The
 * leading-letter rule in `SERVICE_NAME` is the same constraint: a project id
 * may not start with a digit, so `2fa` would yield the invalid `2fa-staging`.
 *
 * Both are checked when the name is typed rather than surfacing later as a GCP
 * API error partway through `runway bootstrap`.
 */
const MAX_NAME_LENGTH = 30 - "-production".length;

/** Reads `--flag value`. Returns undefined when absent or when the value is missing. */
const flagValue = (args: string[], flag: string): string | undefined => {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value?.startsWith("--") ? undefined : value;
};

/**
 * Scaffold a new service repository into `<cwd>/<name>`.
 *
 * Every check runs before the first write, so a rejected invocation leaves the
 * filesystem exactly as it found it.
 */
export const runNew = (args: string[], cwd: string): void => {
  const [name, ...rest] = args;
  const region = flagValue(rest, "--region");

  if (name === undefined || name === "") {
    throw new UsageError("runway new: a service <name> is required.");
  }

  if (name.length > MAX_NAME_LENGTH) {
    throw new UsageError(
      `runway new: service name ${JSON.stringify(name)} is ${name.length} characters; ` +
        `the maximum is ${MAX_NAME_LENGTH}. It becomes the GCP project id ` +
        `"${name}-production", and a project id cannot exceed 30 characters.`,
    );
  }

  if (!SERVICE_NAME.test(name)) {
    throw new UsageError(
      `runway new: invalid service name ${JSON.stringify(name)}. ` +
        "Use lowercase letters, digits and dashes, starting with a letter — " +
        "it becomes a GCP project id, which may not start with a digit.",
    );
  }

  if (region === undefined || region === "") {
    throw new UsageError(
      "runway new: --region is required, e.g. --region europe-west1. " +
        "It is the one value the scaffold cannot derive: project ids come from " +
        "the service name, the region does not.",
    );
  }

  const outdir = join(cwd, name);
  if (existsSync(outdir) && readdirSync(outdir).length > 0) {
    throw new UsageError(
      `runway new: ${name}/ is not empty; refusing to write into it. ` +
        "Choose another name, or empty the directory first.",
    );
  }

  // projen would otherwise run `npm install` as a post-synthesis step. Writing
  // files is this command's job; installing is the user's next one, and the
  // generated README says so.
  process.env.PROJEN_DISABLE_POST = "true";

  const project = new RunwayServiceProject({ name, outdir, region });
  project.synth();

  process.stdout.write(
    [
      "",
      `Created ${name}/`,
      "",
      "  cd " + name,
      "  npm install     # must precede projen: .projenrc.ts imports it",
      "  npm run build",
      "",
    ].join("\n"),
  );
};
