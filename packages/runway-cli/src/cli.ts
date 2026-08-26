#!/usr/bin/env node
import { runBootstrap } from "./commands/bootstrap";
import { runDoctor } from "./commands/doctor";
import { UsageError, runNew } from "./commands/new";

/**
 * Argument parsing and dispatch only — no scaffolding logic lives here.
 *
 * Parsing is hand-rolled rather than delegated to a library: the surface is one
 * command and one flag, and adding a runtime dependency is an ask-first change
 * under SPEC.md's boundaries.
 */

const HELP = `runway — scaffold a GCP service repository

Usage:
  runway new <name> --region <region>
                       Create ./<name> as a new service repository
  runway bootstrap <name> --staging-project <id> [flags]
                       Plan or configure the service's environments
  runway doctor        Check node, npm, pulumi, gcloud and registry auth
  runway --help        Show this message

Arguments:
  --region             GCP region for both environments, e.g. europe-west1.
                       Required: project ids derive from <name>, the region
                       does not.

  <name>               Lowercase letters, digits and dashes. Becomes both the
                       package name and the directory name.

Bootstrap flags:
  --staging-project    Required. Must be <name>-staging: ids derive from the
                       service name; the flag confirms the adoption.
  --production-project Optional — staging may be adopted alone; the service is
                       then reported incomplete until production exists.
  --github-repo        org/repo allowed to deploy production. Required with
                       --production-project.
  --region             Required except with --print-config.
  --developers-group   Group email granted staging deploy (EP-04). Optional:
                       absent means no grant is managed, reported on every run.
  --bootstrap-state    Backend for the bootstrap stack's own state, e.g.
                       gs://<org>-runway-bootstrap-state. Required to provision.
  --dry-run            Print what would be created; change nothing.
  --print-config       Emit the repository variables and state backends.
  --yes                Apply. Without it a provisioning run previews only.
`;

const main = async (argv: string[]): Promise<number> => {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  if (command === "new") {
    runNew(rest, process.cwd());
    return 0;
  }

  if (command === "bootstrap") {
    await runBootstrap(rest);
    return 0;
  }

  if (command === "doctor") {
    return runDoctor();
  }

  process.stderr.write(
    `runway: unknown command ${JSON.stringify(command)}\n\n${HELP}`,
  );
  return 1;
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A usage problem is the user's, not a crash: message only, no stack trace.
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  },
);
