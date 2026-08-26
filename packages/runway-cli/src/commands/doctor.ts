import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RUNWAY_REGISTRY } from "../templates/runway-service-project";

/**
 * The first-run failures, and what to do about each.
 *
 * `doctor` reports and instructs. It never installs, authenticates, or edits a
 * file — the same rule the IAM audit follows: a tool that repairs what it
 * inspects ends up trusted with things it should not have.
 *
 * The check that earns this command's existence is the last one. A fresh clone
 * fails `npm install` with a bare npm 401, three lines below an `.npmrc`
 * comment explaining exactly how to fix it, and nothing connects the two.
 */

/** Matches the scaffold's `minNodeVersion`: below this, Node cannot strip types. */
export const MIN_NODE = "22.18.0";

/** npm workspaces predate this, but the lockfile format does not. */
export const MIN_NPM = "10.0.0";

/** The registry host, as it appears in an npm auth line — no scheme, no scope. */
const REGISTRY_HOST = RUNWAY_REGISTRY.replace(/^https:/, "");

export interface Environment {
  /** Undefined means "not installed", not "unknown". */
  readonly node: string | undefined;
  readonly npm: string | undefined;
  readonly pulumi: string | undefined;
  readonly gcloud: string | undefined;
  /** Whether the user's own ~/.npmrc carries a credential for `@runway`. */
  readonly registryAuth: boolean;
}

export interface Finding {
  readonly ok: boolean;
  readonly summary: string;
  /**
   * What to run. Always present when `ok` is false: a diagnosis a developer
   * cannot act on is the failure this command exists to prevent.
   */
  readonly fix?: string;
}

/** `"v22.18.0-nightly"` → `[22, 18, 0]`. Non-numeric segments count as zero. */
const versionParts = (version: string): number[] =>
  version
    .replace(/^v/, "")
    .split(/[-+]/)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);

/**
 * Numeric version comparison, without a semver dependency.
 *
 * Prerelease and build metadata are dropped rather than ordered — `doctor`
 * asks "is this new enough", and nobody runs a Node prerelease by accident.
 */
export const atLeast = (actual: string, minimum: string): boolean => {
  const a = versionParts(actual);
  const b = versionParts(minimum);
  for (let i = 0; i < b.length; i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return true;
};

/**
 * Whether an `.npmrc` body authenticates against the `@runway` registry.
 *
 * Looks for npm's own auth line shape — `//host/path/:_authToken=...` — rather
 * than for the scope mapping, which the *generated repo* commits and which
 * carries no credential by design.
 */
export const hasRegistryAuth = (npmrc: string): boolean =>
  npmrc
    .split("\n")
    .map((line) => line.trim())
    .some(
      (line) =>
        !line.startsWith("#") &&
        line.startsWith(REGISTRY_HOST) &&
        /:(_authToken|_password)=\S/.test(line),
    );

/** A version string from a `--version` command, or undefined if it is not installed. */
const versionOf = (command: string, args: string[]): string | undefined => {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /(\d+\.\d+\.\d+)/.exec(output)?.[1];
  } catch {
    return undefined;
  }
};

/** Reads the machine. Everything it returns is injectable, so `diagnose` stays pure. */
export const probe = (): Environment => {
  let npmrc = "";
  try {
    npmrc = readFileSync(join(homedir(), ".npmrc"), "utf-8");
  } catch {
    // No ~/.npmrc at all is the common first-run case, not an error.
  }

  return {
    node: process.versions.node,
    npm: versionOf("npm", ["--version"]),
    pulumi: versionOf("pulumi", ["version"]),
    gcloud: versionOf("gcloud", ["--version"]),
    registryAuth: hasRegistryAuth(npmrc),
  };
};

/** The whole of the command's judgement, as a pure function of the environment. */
export const diagnose = (env: Environment): Finding[] => [
  {
    ok: env.node !== undefined && atLeast(env.node, MIN_NODE),
    summary: `Node ${env.node ?? "not found"} (need >= ${MIN_NODE})`,
    fix: `Install Node ${MIN_NODE} or newer. Below it, .projenrc.ts cannot run: ts-node does not load under TypeScript 7, so projen relies on Node's own type stripping.`,
  },
  {
    ok: env.npm !== undefined && atLeast(env.npm, MIN_NPM),
    summary: `npm ${env.npm ?? "not found"} (need >= ${MIN_NPM})`,
    fix: `Install npm ${MIN_NPM} or newer: npm install -g npm@latest`,
  },
  {
    ok: env.pulumi !== undefined,
    summary: `Pulumi CLI ${env.pulumi ?? "not found"}`,
    fix: "Install the Pulumi CLI: https://www.pulumi.com/docs/install/ — needed to preview or deploy infra/.",
  },
  {
    ok: env.gcloud !== undefined,
    summary: `gcloud ${env.gcloud ?? "not found"}`,
    fix: "Install the Google Cloud CLI: https://cloud.google.com/sdk/docs/install — needed to authenticate against GCP.",
  },
  {
    ok: env.registryAuth,
    summary: `Artifact Registry credential for @runway ${env.registryAuth ? "present" : "missing"}`,
    fix: [
      "Authenticate once, into your own ~/.npmrc — never into a repo, which would commit the token:",
      "  npx google-artifactregistry-auth --credential-config=$HOME/.npmrc",
      "Without it, npm install in a generated repo fails with a bare 401.",
    ].join("\n"),
  },
];

/**
 * Prints the diagnosis. Non-zero exit when anything is missing, so it composes
 * into a setup script rather than only being read by a human.
 */
export const runDoctor = (
  env: Environment = probe(),
  out: NodeJS.WritableStream = process.stdout,
): number => {
  const findings = diagnose(env);

  for (const finding of findings) {
    out.write(`${finding.ok ? "ok  " : "FAIL"}  ${finding.summary}\n`);
    if (!finding.ok && finding.fix !== undefined) {
      // Indented as a block: a fix whose second line starts at column zero
      // reads as a separate finding.
      for (const line of finding.fix.split("\n")) {
        out.write(`      ${line}\n`);
      }
    }
  }

  const failed = findings.filter((finding) => !finding.ok).length;
  out.write(
    failed === 0
      ? "\nEverything this repo needs is present.\n"
      : `\n${failed} of ${findings.length} checks failed.\n`,
  );

  return failed === 0 ? 0 : 1;
};
