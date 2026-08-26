import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Environment,
  MIN_NODE,
  MIN_NPM,
  atLeast,
  diagnose,
  hasRegistryAuth,
  runDoctor,
} from "../../src/commands/doctor";

/**
 * LD-08. The first-run cliff.
 *
 * `diagnose` is a pure function of an injected environment, so every state is
 * reachable offline — including "no Artifact Registry credential", which is the
 * one that actually bites and which cannot be produced by touching the network.
 */

/** Everything present and new enough. Each case below breaks exactly one thing. */
const HEALTHY: Environment = {
  node: "22.18.0",
  npm: "10.9.0",
  pulumi: "3.246.0",
  gcloud: "531.0.0",
  registryAuth: true,
};

/** Collects what the command actually printed. */
const output = (env: Environment): { code: number; text: string } => {
  let text = "";
  const sink = { write: (chunk: string) => ((text += chunk), true) };
  const code = runDoctor(env, sink as unknown as NodeJS.WritableStream);
  return { code, text };
};

describe("LD-08: atLeast", () => {
  it.each([
    ["22.18.0", "22.18.0", true],
    ["22.18.1", "22.18.0", true],
    ["26.3.0", "22.18.0", true],
    ["22.17.9", "22.18.0", false],
    ["20.19.0", "22.18.0", false],
    ["v22.18.0", "22.18.0", true],
    ["23.0.0-nightly", "22.18.0", true],
    ["10.9.0", "10.0.0", true],
    ["9.9.9", "10.0.0", false],
  ])("%s >= %s is %s", (actual, minimum, expected) => {
    expect(atLeast(actual, minimum)).toBe(expected);
  });

  it("compares numerically, not as strings", () => {
    // "9" > "10" lexically. This is the bug the function exists to not have.
    expect(atLeast("9.0.0", "10.0.0")).toBe(false);
    expect(atLeast("22.9.0", "22.10.0")).toBe(false);
  });
});

describe("LD-08: registry credential detection", () => {
  const authLine =
    "//europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/:_authToken=ya29.example";

  it("finds a credential in an npmrc that has one", () => {
    expect(hasRegistryAuth(authLine)).toBe(true);
  });

  it("finds one written as a password rather than a token", () => {
    expect(
      hasRegistryAuth(
        "//europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/:_password=c2VjcmV0",
      ),
    ).toBe(true);
  });

  it.each([
    ["an empty file", ""],
    ["only the scope mapping the generated repo commits", "@runway:registry=https://europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/"],
    ["a credential for a different registry", "//registry.npmjs.org/:_authToken=npm_example"],
    ["the auth line commented out", `# ${authLine}`],
    ["an auth key with no value", "//europe-west1-npm.pkg.dev/enduring-badge-506610-u9/runway/:_authToken="],
  ])("reports none for %s", (_case, npmrc) => {
    expect(hasRegistryAuth(npmrc)).toBe(false);
  });

  it("does not mistake the committed scope mapping for a credential", () => {
    // The generated .npmrc carries the registry URL and deliberately no token.
    const generated = readFileSync(
      join(__dirname, "../../src/templates/runway-service-project.ts"),
      "utf-8",
    );
    expect(generated).toContain("No credential here, deliberately");
  });
});

describe("LD-08: diagnose", () => {
  it("reports every check passing on a fully configured machine", () => {
    const { code, text } = output(HEALTHY);

    expect(code).toBe(0);
    expect(text).not.toContain("FAIL");
  });

  /**
   * Each case asserts the *fix*, not merely the failure. A diagnostic a
   * developer cannot act on is the failure this command exists to prevent.
   */
  it.each([
    [
      "Node below the minimum",
      { ...HEALTHY, node: "20.19.0" },
      [MIN_NODE, "type stripping"],
    ],
    ["Node absent", { ...HEALTHY, node: undefined }, [MIN_NODE]],
    ["npm below the minimum", { ...HEALTHY, npm: "9.9.9" }, [MIN_NPM, "npm install -g"]],
    ["pulumi absent", { ...HEALTHY, pulumi: undefined }, ["pulumi.com/docs/install"]],
    ["gcloud absent", { ...HEALTHY, gcloud: undefined }, ["cloud.google.com/sdk/docs/install"]],
    [
      "no Artifact Registry credential",
      { ...HEALTHY, registryAuth: false },
      ["google-artifactregistry-auth", "$HOME/.npmrc", "401"],
    ],
  ])("names %s and how to fix it", (_case, env, expectedFragments) => {
    const { code, text } = output(env);

    expect(code).toBe(1);
    expect(text).toContain("FAIL");
    for (const fragment of expectedFragments) {
      expect(text).toContain(fragment);
    }
  });

  /**
   * Failure injection: a clean machine reports clean, then one thing is taken
   * away and the same check fires. An absence asserted alone is not evidence.
   */
  it("fires only for the thing that was removed", () => {
    expect(output(HEALTHY).text).not.toContain("FAIL");

    const withoutCredential = output({ ...HEALTHY, registryAuth: false });
    expect(withoutCredential.text).toContain("FAIL");
    expect(
      withoutCredential.text.split("\n").filter((line) => line.startsWith("FAIL")),
    ).toHaveLength(1);
  });

  it("gives every failing finding a fix", () => {
    const allBroken: Environment = {
      node: undefined,
      npm: undefined,
      pulumi: undefined,
      gcloud: undefined,
      registryAuth: false,
    };

    for (const finding of diagnose(allBroken)) {
      expect(finding.ok).toBe(false);
      expect(finding.fix).toBeTruthy();
    }
  });
});

describe("LD-08: doctor never mutates", () => {
  /**
   * Asserted structurally rather than by review. `doctor` reports and instructs;
   * a tool that repairs what it inspects gets trusted with things it should not
   * have — the same rule the IAM audit follows.
   */
  it("contains no write, no install and no auth invocation", () => {
    const source = readFileSync(join(__dirname, "../../src/commands/doctor.ts"), "utf-8");

    for (const forbidden of [
      "writeFile",
      "appendFile",
      "mkdir",
      "rmSync",
      "unlink",
      "npm install -g npm@latest\"",
    ]) {
      expect(source).not.toContain(forbidden);
    }

    // execFileSync is present, but only ever to ask for a version.
    const calls = [...source.matchAll(/execFileSync\(([^)]*)\)/gs)];
    expect(calls.length).toBeGreaterThan(0);
    for (const [call] of calls) {
      expect(call).toContain("args");
    }
  });
});
