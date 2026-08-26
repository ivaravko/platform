import { MAX_NAME_LENGTH, SERVICE_NAME, UsageError, flagValue } from "./new";

/**
 * `runway bootstrap` — parsing and composition for the identity boundary.
 *
 * Provisioning itself is not wired yet: it needs credentials, a state
 * backend, and the authorization question plan OQ2 answers. What already
 * holds: every refusal fires before anything else could run, every name is
 * derived by the shared rule rather than trusted from a flag, and a service
 * without production is reported incomplete on every run (EP-07).
 *
 * No dependency on @runway/environment-provisioning, deliberately. The two
 * modules never tell each other an identifier — both compute it — and a
 * runtime dependency here would put an unpublished package into every
 * generated repository's install tree. The four not-enforced control ids
 * below are the same list `serviceCompleteness` states; its test is the
 * canonical one.
 */

/** GitHub repository as "org/repo" — exactly one, no wildcards. */
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

interface BootstrapOptions {
  readonly service: string;
  readonly production: boolean;
  readonly repository?: string;
  readonly region?: string;
}

/** What `--dry-run` prints for one environment. Derivation, not configuration. */
const environmentPlan = (options: BootstrapOptions, environment: string): string[] => {
  const project = `${options.service}-${environment}`;
  const lines = [
    `${environment}: adopt project ${project}`,
    `  state bucket        gs://${project}-state (versioned, uniform access, no public access)`,
  ];
  if (environment === "staging") {
    lines.push(
      "  deploy grant        roles/run.developer -> the developers group (supplied at provisioning)",
    );
  } else {
    lines.push(
      `  deploy grant        roles/run.admin -> serviceAccount:${options.service}-deployer@${project}.iam.gserviceaccount.com`,
      `  identity pool       ${options.service}-github, provider "github"`,
      `  federation          ${options.repository ?? "<org/repo>"}, refs/tags/v* — the release path's tags`,
    );
  }
  return lines;
};

/** EP-07, on every run: visibly, never by omission. */
const completenessReport = (production: boolean): string[] =>
  production
    ? ["Service: complete — both environments configured."]
    : [
        "Service: INCOMPLETE — no production environment.",
        "  Not enforced until it exists: EP-01, EP-02, EP-03, EP-06.",
      ];

const printConfig = (options: BootstrapOptions): string[] => {
  const production = `${options.service}-production`;
  const lines = [
    `# Repository variables for ${options.service}'s workflows (Settings > Variables).`,
    "# The WIF provider path needs the production project's number, which only a",
    "# credentialed bootstrap run can resolve; <project-number> marks it.",
    `RUNWAY_WIF_PROVIDER=projects/<project-number>/locations/global/workloadIdentityPools/${options.service}-github/providers/github`,
    `RUNWAY_CI_SERVICE_ACCOUNT=${options.service}-deployer@${production}.iam.gserviceaccount.com`,
    `RUNWAY_PRODUCTION_STATE_BACKEND=gs://${production}-state`,
    "",
    `# Staging state backend, for developers' own pulumi login:`,
    `# gs://${options.service}-staging-state`,
  ];
  return [...lines, "", ...completenessReport(options.production)];
};

/**
 * Parse, validate, and — for now — plan. Every check precedes any output, so
 * a refused invocation does nothing at all.
 */
export const runBootstrap = (args: string[]): void => {
  const [name, ...rest] = args;

  if (name === undefined || name === "" || name.startsWith("--")) {
    throw new UsageError("runway bootstrap: a service <name> is required.");
  }
  if (!SERVICE_NAME.test(name) || name.length > MAX_NAME_LENGTH) {
    throw new UsageError(
      `runway bootstrap: invalid service name ${JSON.stringify(name)}. ` +
        "Lowercase letters, digits and dashes, starting with a letter, at " +
        `most ${MAX_NAME_LENGTH} characters — it derives both project ids.`,
    );
  }

  const stagingProject = flagValue(rest, "--staging-project");
  const productionProject = flagValue(rest, "--production-project");
  const repository = flagValue(rest, "--github-repo");
  const region = flagValue(rest, "--region");
  const printOnly = rest.includes("--print-config");
  const dryRun = rest.includes("--dry-run");

  if (stagingProject === undefined) {
    throw new UsageError(
      "runway bootstrap: --staging-project is required. Production is " +
        "optional — a service may adopt staging alone and add production later.",
    );
  }
  // The flag is confirmation, not configuration: project ids derive from the
  // service name, the same rule the scaffold's stack configs compute with. A
  // mismatch is a typo about to become someone's IAM.
  if (stagingProject !== `${name}-staging`) {
    throw new UsageError(
      `runway bootstrap: --staging-project must be "${name}-staging" — project ` +
        `ids derive from the service name. Got ${JSON.stringify(stagingProject)}. ` +
        "(Projects that predate the convention are not supported yet.)",
    );
  }
  if (productionProject !== undefined && productionProject !== `${name}-production`) {
    throw new UsageError(
      `runway bootstrap: --production-project must be "${name}-production" — ` +
        `project ids derive from the service name. Got ${JSON.stringify(productionProject)}.`,
    );
  }
  if (repository !== undefined && !REPOSITORY.test(repository)) {
    throw new UsageError(
      `runway bootstrap: --github-repo must name exactly one repository as ` +
        `"org/repo" — got ${JSON.stringify(repository)}.`,
    );
  }
  if (productionProject !== undefined && repository === undefined) {
    throw new UsageError(
      "runway bootstrap: --github-repo is required with --production-project — " +
        "the federation must name the one repository allowed to deploy.",
    );
  }

  const options: BootstrapOptions = {
    service: name,
    production: productionProject !== undefined,
    ...(repository === undefined ? {} : { repository }),
    ...(region === undefined ? {} : { region }),
  };

  if (printOnly) {
    process.stdout.write(`${printConfig(options).join("\n")}\n`);
    return;
  }

  if (region === undefined) {
    throw new UsageError(
      "runway bootstrap: --region is required, e.g. --region europe-west1 — " +
        "the state buckets need a location.",
    );
  }

  if (dryRun) {
    const plan = [
      `Plan for ${name} (region ${region}):`,
      "",
      ...environmentPlan(options, "staging"),
      ...(options.production ? ["", ...environmentPlan(options, "production")] : []),
      "",
      ...completenessReport(options.production),
      "",
      "Nothing was changed.",
    ];
    process.stdout.write(`${plan.join("\n")}\n`);
    return;
  }

  throw new UsageError(
    "runway bootstrap: provisioning is not wired yet. Run with --dry-run to " +
      "see the plan, or --print-config for the repository contract.",
  );
};
