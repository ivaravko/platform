import { spawnSync } from "node:child_process";
import { MAX_NAME_LENGTH, SERVICE_NAME, UsageError, flagValue } from "./new";

/**
 * `runway bootstrap` — the identity boundary, from parsing to provisioning.
 *
 * Every refusal fires before anything else could run, every name is derived
 * by the shared rule rather than trusted from a flag, and a service without
 * production is reported incomplete on every run (EP-07). The wet path runs
 * the ServiceEnvironment program through the Automation API against the
 * bootstrap state backend the operator names — previewing by default, and
 * applying only under `--yes`.
 *
 * The heavy imports (@pulumi/pulumi/automation, the environment module) are
 * loaded lazily inside the wet path, so `runway new` and the offline modes
 * never pay for them. The production project's live IAM policy is fetched by
 * shelling out to gcloud — the operator running bootstrap has it, and the
 * audit inside ServiceEnvironment then judges the real bindings (EP-06).
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
      `  federation          ${options.repository ?? "<org/repo>"}: refs/heads/main (image pushes) + refs/tags/v* (releases)`,
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
 * Parse, validate, then plan or provision. Every check precedes any output,
 * so a refused invocation does nothing at all.
 */
export const runBootstrap = async (args: string[]): Promise<void> => {
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
  const developersGroup = flagValue(rest, "--developers-group");
  const bootstrapState = flagValue(rest, "--bootstrap-state");
  const printOnly = rest.includes("--print-config");
  const dryRun = rest.includes("--dry-run");
  const yes = rest.includes("--yes");

  if (developersGroup !== undefined && developersGroup.includes(":")) {
    throw new UsageError(
      `runway bootstrap: --developers-group takes the group's bare email — ` +
        `got ${JSON.stringify(developersGroup)}. An individual is refused ` +
        `either way (EP-04).`,
    );
  }

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

  if (bootstrapState === undefined) {
    throw new UsageError(
      "runway bootstrap: --bootstrap-state is required to provision — the " +
        "backend holding the bootstrap stack's own state, e.g. " +
        "gs://<org>-runway-bootstrap-state (hand-made once per organisation; " +
        "see SPEC-environment-provisioning.md). Use --dry-run to plan without one.",
    );
  }

  return provision({
    service: name,
    region,
    repository,
    developersGroup,
    production: productionProject !== undefined,
    bootstrapState,
    yes,
  });
};

interface ProvisionOptions {
  readonly service: string;
  readonly region: string;
  readonly repository?: string;
  readonly developersGroup?: string;
  readonly production: boolean;
  readonly bootstrapState: string;
  readonly yes: boolean;
}

/** Runs gcloud, returning parsed stdout — or throws with stderr attached. */
const gcloudJson = (args: readonly string[]): Record<string, unknown> => {
  const result = spawnSync("gcloud", [...args, "--format=json"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(`gcloud ${args.join(" ")} failed:\n${result.stderr}`);
  }
  const parsed: unknown = JSON.parse(result.stdout);
  // Narrowed, not cast: a mis-shaped response must fail here, loudly, not
  // flow onward as whatever the caller hoped for.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`gcloud ${args.join(" ")} returned a non-object response.`);
  }
  return { ...parsed };
};

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * The production project's live IAM policy plus resolved custom roles — the
 * audit's raw material, fetched exactly the way the integration tier does.
 */
const fetchProductionPolicy = (
  project: string,
): {
  readonly bindings: { readonly role: string; readonly members: readonly string[] }[];
  readonly customRolePermissions: Record<string, readonly string[]>;
} => {
  const policy = gcloudJson(["projects", "get-iam-policy", project]);
  const rawBindings = Array.isArray(policy.bindings) ? policy.bindings : [];
  const bindings = rawBindings.map((raw: unknown) => {
    const binding: Record<string, unknown> =
      typeof raw === "object" && raw !== null ? { ...raw } : {};
    return {
      role: typeof binding.role === "string" ? binding.role : "",
      members: strings(binding.members),
    };
  });

  const customRoles = [
    ...new Set(bindings.map((b) => b.role).filter((r) => !r.startsWith("roles/"))),
  ];
  const customRolePermissions = Object.fromEntries(
    customRoles.map((role) => {
      const definition = gcloudJson(["iam", "roles", "describe", role]);
      return [role, strings(definition.includedPermissions)];
    }),
  );

  return { bindings, customRolePermissions };
};

/**
 * The wet path: preview by default, apply under `--yes`. The audit runs
 * inside ServiceEnvironment's construction, against the live policy fetched
 * a moment before — so an EP-06 refusal surfaces here as the program failing
 * with the audit's full message, before any resource operation.
 */
const provision = async (options: ProvisionOptions): Promise<void> => {
  const { LocalWorkspace } = await import("@pulumi/pulumi/automation");
  const { ServiceEnvironment } = await import("@runway/environment-provisioning");

  const productionPolicy = options.production
    ? fetchProductionPolicy(`${options.service}-production`)
    : undefined;

  const program = async (): Promise<Record<string, unknown>> => {
    const staging = new ServiceEnvironment("staging", {
      service: options.service,
      environment: "staging",
      location: options.region,
      deployableBy: {
        humans:
          options.developersGroup === undefined
            ? {}
            : { group: options.developersGroup },
      },
      // With a repository named, staging gets its CI image publisher: a
      // federated identity holding registry writer and nothing else, so the
      // repo's CI can install and push images before production exists.
      ...(options.repository === undefined
        ? {}
        : { ciImagePublisher: { repository: options.repository } }),
    });

    const outputs: Record<string, unknown> = {
      stagingProject: staging.project,
      stagingStateBucket: staging.stateBucket.name,
      ...(staging.imagePublisher === undefined
        ? {}
        : {
            stagingWifProvider: staging.imagePublisher.provider.name,
            stagingPublisherEmail: staging.imagePublisher.deployerEmail,
          }),
    };

    if (productionPolicy !== undefined && options.repository !== undefined) {
      const production = new ServiceEnvironment("production", {
        service: options.service,
        environment: "production",
        location: options.region,
        deployableBy: {
          ci: {
            repository: options.repository,
            // main pushes images; version tags release them. See EP-02.
            refs: ["refs/heads/main", "refs/tags/v*"],
            existingPolicy: { bindings: productionPolicy.bindings },
            customRolePermissions: productionPolicy.customRolePermissions,
          },
        },
      });
      outputs.productionProject = production.project;
      outputs.productionStateBucket = production.stateBucket.name;
      outputs.deployerEmail = production.federation?.deployerEmail;
      outputs.wifProvider = production.federation?.provider.name;
    }

    return outputs;
  };

  const stack = await LocalWorkspace.createOrSelectStack(
    { stackName: options.service, projectName: "runway-bootstrap", program },
    {
      projectSettings: {
        name: "runway-bootstrap",
        runtime: "nodejs",
        backend: { url: options.bootstrapState },
      },
      // The bootstrap stack stores no secret, so the passphrase encrypts
      // nothing and an empty one costs nothing. See the integration tier's
      // identical reasoning.
      envVars: { PULUMI_CONFIG_PASSPHRASE: "" },
    },
  );

  if (!options.yes) {
    const preview = await stack.preview();
    process.stdout.write(`${JSON.stringify(preview.changeSummary)}\n`);
    process.stdout.write(
      `${completenessReport(options.production).join("\n")}\n\n` +
        "Preview only. Run again with --yes to apply.\n",
    );
    return;
  }

  await stack.up({ onOutput: (line) => process.stdout.write(line) });
  const outputs = await stack.outputs();
  const value = (key: string): string => String(outputs[key]?.value ?? "");

  const lines = [
    "",
    `Bootstrapped ${options.service}.`,
    "",
    ...completenessReport(options.production),
  ];
  if (options.production) {
    lines.push(
      "",
      "# Repository variables for the service's workflows (Settings > Variables):",
      `RUNWAY_WIF_PROVIDER=${value("wifProvider")}/providers/github`,
      `RUNWAY_CI_SERVICE_ACCOUNT=${value("deployerEmail")}`,
      `RUNWAY_PRODUCTION_STATE_BACKEND=gs://${value("productionStateBucket")}`,
    );
  } else if (value("stagingWifProvider") !== "") {
    lines.push(
      "",
      "# Repository variables for the service's workflows (Settings > Variables).",
      "# Staging's image publisher: CI installs and pushes images with these.",
      "# RUNWAY_PRODUCTION_STATE_BACKEND stays unset until production exists,",
      "# so release.yml keeps refusing -- correctly.",
      `RUNWAY_WIF_PROVIDER=${value("stagingWifProvider")}/providers/github`,
      `RUNWAY_CI_SERVICE_ACCOUNT=${value("stagingPublisherEmail")}`,
    );
  }
  lines.push("", `Staging state backend: gs://${value("stagingStateBucket")}`, "");
  process.stdout.write(lines.join("\n"));
};
