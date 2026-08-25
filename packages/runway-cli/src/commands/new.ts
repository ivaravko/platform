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
export const SERVICE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/** npm's package-name limit. */
const MAX_NAME_LENGTH = 214;

/**
 * Scaffold a new service repository into `<cwd>/<name>`.
 *
 * Every check runs before the first write, so a rejected invocation leaves the
 * filesystem exactly as it found it.
 */
export const runNew = (args: string[], cwd: string): void => {
  const name = args[0];

  if (name === undefined || name === "") {
    throw new UsageError("runway new: a service <name> is required.");
  }

  if (!SERVICE_NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new UsageError(
      `runway new: invalid service name ${JSON.stringify(name)}. ` +
        "Use lowercase letters, digits and dashes, starting with a letter or digit.",
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

  const project = new RunwayServiceProject({ name, outdir });
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
