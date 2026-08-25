import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Builds the CrossGuard pack somewhere Pulumi can actually load it.
 *
 * **The pack cannot run from inside this monorepo, and that is not a
 * configuration mistake.** The policy-pack runner is a different code path from
 * the stack runner: it hardcodes ts-node on (`typeScript: !process.versions.bun`)
 * and never reads `PulumiPolicy.yaml`'s runtime options, so the `typescript:
 * false` that saves stack programs is inert here. Pulumi falls back to its
 * vendored `typescript@3.8.3` only when `require("typescript")` *throws* —
 * and TypeScript 7 imports fine, it simply has no compiler API. The fallback
 * never fires, and the vendored ts-node dies on `ts.sys.readFile`.
 *
 * Verified both ways. From the repo: `TypeError: Cannot read properties of
 * undefined (reading 'readFile')` and `policy pack not started`. From a tree
 * where `typescript` does not resolve: `✅ runway-gcp@v0.0.1`.
 *
 * So the pack is staged outside the repo, with its own `node_modules` holding
 * the Pulumi packages and **deliberately not TypeScript**. Node resolves by
 * walking up from the requiring module, so a directory under the OS temp dir
 * cannot reach this repo's `node_modules`.
 *
 * See SPEC.md, "ts-node's breakage reaches further than projen".
 */

const REPO_ROOT = join(__dirname, "..", "..");
const COMPONENTS = join(REPO_ROOT, "packages", "gcp-components");

/**
 * Pinned to match the components' peer ranges.
 *
 * `@pulumi/gcp` is here because the rules import it for its types, and its
 * absence is not a load error — it is a `MODULE_NOT_FOUND` thrown from inside
 * the pack after the runner has already started, which reads as a pack bug
 * rather than a missing dependency.
 */
const PACK_DEPENDENCIES = [
  "@pulumi/policy@1.21.0",
  "@pulumi/pulumi@3.259.0",
  "@pulumi/gcp@9.35.1",
];

/**
 * A marker recording what the staged tree was built from.
 *
 * Staging costs an `npm install` of three large packages, so the tree is reused
 * across runs — but only when the compiled pack and the pinned versions are
 * unchanged. Reusing a stale tree would test yesterday's rules and report them
 * as today's.
 */
const stamp = (): string =>
  JSON.stringify({
    dependencies: PACK_DEPENDENCIES,
    pack: readFileSync(join(COMPONENTS, "lib", "policy", "policies.js"), "utf-8")
      .length,
    rules: readFileSync(
      join(COMPONENTS, "lib", "policy", "cloud-run-rules.js"),
      "utf-8",
    ).length,
  });

/** Absolute path to a loadable pack directory, staged on first use. */
export const isolatedPolicyPack = (): string => {
  const root = join(tmpdir(), "runway-integration-policy-pack");
  const packDir = join(root, "policy");
  const marker = join(root, ".stamp");
  const current = stamp();

  if (existsSync(marker) && readFileSync(marker, "utf-8") === current) {
    return packDir;
  }

  mkdirSync(root, { recursive: true });
  // `policy/index.js` requires `../lib/policy/pack`, so lib must stay a sibling.
  cpSync(join(COMPONENTS, "policy"), packDir, { recursive: true });
  cpSync(join(COMPONENTS, "lib"), join(root, "lib"), { recursive: true });

  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "runway-integration-policy-pack", private: true, version: "0.0.0" }, null, 2)}\n`,
  );
  // The same escape hatch the repo ships: @pulumi/pulumi's stale peer range on
  // typescript would otherwise fail this install with ERESOLVE.
  writeFileSync(join(root, ".npmrc"), "legacy-peer-deps=true\n");

  execFileSync("npm", ["install", "--no-audit", "--no-fund", ...PACK_DEPENDENCIES], {
    cwd: root,
    stdio: "pipe",
  });

  assertTypeScriptUnreachable(root);

  writeFileSync(marker, current);
  return packDir;
};

/**
 * The invariant the whole arrangement rests on, checked rather than assumed.
 *
 * If `typescript` ever becomes resolvable from the staged tree — a transitive
 * dependency picks it up, npm hoists differently — the pack stops loading and
 * the failure is `ts.sys.readFile`, which points nowhere near the cause. Better
 * to fail here, naming it.
 */
const assertTypeScriptUnreachable = (root: string): void => {
  const result = execFileSync(
    process.execPath,
    [
      "-e",
      "try { require.resolve('typescript'); console.log('resolves') } catch { console.log('absent') }",
    ],
    { cwd: root, encoding: "utf-8" },
  ).trim();

  if (result !== "absent") {
    throw new Error(
      `The staged policy pack at ${root} can resolve "typescript". Pulumi will ` +
        "then skip its vendored TypeScript fallback and the pack will fail to " +
        "load with `ts.sys.readFile` undefined. See SPEC.md.",
    );
  }
};
