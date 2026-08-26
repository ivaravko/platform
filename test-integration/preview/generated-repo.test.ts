import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { LocalWorkspace, type Stack } from "@pulumi/pulumi/automation";
import { RunwayServiceProject } from "@runway/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type PlannedResource,
  collectPlanned,
  onlyResourceOfType,
  stringAt,
} from "../support/stack";
import {
  SANDBOX_PROJECT_ID,
  SANDBOX_REGION,
  assertSandbox,
} from "../support/sandbox";

/**
 * The premise of the whole module, planned against the real provider: the repo
 * `runway new` emits actually deploys.
 *
 * D6 established this once, by hand. Nothing re-established it afterwards, so a
 * change to the scaffold could break the generated stack and every suite would
 * stay green. This is that check, made repeatable.
 *
 * **The generated stack config is deliberately overridden here.** A scaffold
 * targets `demo-staging` and `demo-production`, projects that do not exist and
 * are not ours; the sandbox is the only project this tier may touch. What that
 * costs is that the derived ids are *not* proven here — they are asserted in the
 * scaffold's own unit tests. What it buys is proof that the program those ids
 * feed compiles, resolves its config, and plans what it should.
 */

assertSandbox();

const SAMPLE_DIGEST =
  "sha256:0000000000000000000000000000000000000000000000000000000000000000";

let repo: string;

/**
 * An npm config file carrying a short-lived Artifact Registry token.
 *
 * Written next to the scaffold and passed as `--userconfig`, rather than
 * touching the developer's `~/.npmrc`: a test that edits a file in someone's
 * home directory is a test that has to be trusted to clean up after itself, and
 * this one is deleted with the temp repo either way. The scaffold's own
 * committed `.npmrc` still supplies the scope mapping — only the credential is
 * added here, which is the same split a real developer gets.
 */
const registryAuth = (dir: string): string => {
  const token = execFileSync("gcloud", ["auth", "print-access-token"], {
    encoding: "utf-8",
  }).trim();
  const host = "//europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/";
  const path = join(dir, ".npmrc-auth");
  writeFileSync(path, `${host}:_authToken=${token}\n`, { mode: 0o600 });
  return path;
};

/** Scaffold, install and build once; both previews run against the same repo. */
beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "runway-generated-"));
  new RunwayServiceProject({
    name: "demo",
    outdir: repo,
    region: SANDBOX_REGION,
  }).synth();

  // Pulumi runs `main: lib/index.js`, so the build is not optional here -- an
  // unbuilt repo fails with a missing entrypoint rather than a plan error.
  //
  // Installed against the real Artifact Registry, deliberately. This is the only
  // tier that resolves `@runway/*` the way a user's repo does; runway-cli's own
  // build-out tests link the workspace copies, because gating a unit tier on
  // Google credentials would make it red for reasons unrelated to the code.
  // So the claim "a generated repo installs from the published registry" is
  // proven here or nowhere.
  execFileSync("npm", ["install", "--userconfig", registryAuth(repo)], {
    cwd: repo,
    stdio: "pipe",
  });
  execFileSync("npm", ["run", "build"], { cwd: repo, stdio: "pipe" });
}, 900_000);

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

/**
 * Plan one of the generated stacks against the sandbox.
 *
 * `extraConfig` is what distinguishes the two environments, exactly as it does
 * in a real repository: nothing about the program differs between them.
 */
const previewGenerated = async <T>(
  stackName: string,
  extraConfig: Record<string, { value: string }>,
  body: (stack: Stack) => Promise<T>,
): Promise<T> => {
  const workDir = join(repo, "infra");
  const stack = await LocalWorkspace.createOrSelectStack(
    { stackName, workDir },
    { envVars: { PULUMI_CONFIG_PASSPHRASE: randomBytes(24).toString("hex") } },
  );

  try {
    await stack.setAllConfig({
      "gcp:project": { value: SANDBOX_PROJECT_ID },
      "gcp:region": { value: SANDBOX_REGION },
      ...extraConfig,
    });
    return await body(stack);
  } finally {
    await stack.workspace.removeStack(stackName, { force: true });
  }
};

describe("the repo runway new emits", () => {
  it(
    "plans three resource groups on staging, none of them public",
    { timeout: 600_000 },
    async () => {
      await previewGenerated(
        "staging",
        { "demo:imageTag": { value: "v1" } },
        async (stack) => {
          const planned: PlannedResource[] = [];
          await stack.preview({ onEvent: collectPlanned(planned) });

          expect(onlyResourceOfType(planned, "gcp:artifactregistry/repository:Repository")).toBeDefined();
          expect(onlyResourceOfType(planned, "gcp:serviceaccount/account:Account")).toBeDefined();

          const service = onlyResourceOfType(
            planned,
            "gcp:cloudrunv2/service:Service",
          );
          // Private by default is the component's central claim; a generated
          // repo that quietly published a service would defeat the module.
          expect(stringAt(service.inputs, "ingress")).toBe(
            "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER",
          );
        },
      );
    },
  );

  it(
    "plans on production once a digest is configured",
    { timeout: 600_000 },
    async () => {
      // A generated production stack carries no image, because nothing has been
      // promoted to it. Configuring a digest is what CI does at promotion, and
      // it is the only difference between this preview and staging's.
      await previewGenerated(
        "production",
        { "demo:imageDigest": { value: SAMPLE_DIGEST } },
        async (stack) => {
          const planned: PlannedResource[] = [];
          await stack.preview({ onEvent: collectPlanned(planned) });

          const service = onlyResourceOfType(
            planned,
            "gcp:cloudrunv2/service:Service",
          );

          // The digest reached the container, not the tag: promotion moves an
          // artifact rather than rebuilding one. Asserted on the serialised
          // inputs because the image sits inside an array, which `stringAt`
          // deliberately does not traverse.
          const inputs = JSON.stringify(service.inputs);
          expect(inputs).toContain(`@${SAMPLE_DIGEST}`);
          expect(inputs).not.toMatch(/demo:v\d/);
        },
      );
    },
  );
});
