import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Locates the policy pack in the tree D1 built for running it.
 *
 * **This delegates to `policy:install` rather than staging its own tree.** An
 * earlier version of this file built one under the OS temp dir on the theory
 * that the pack needs somewhere `typescript` does not resolve. That theory was
 * wrong, and wrong in a way that happened to work: it held only by accident of
 * location. D1 measured the real constraint — **the nearest resolvable
 * `typescript` must have a compiler API.** Pulumi's policy runner hardcodes
 * ts-node on, resolves `typescript` from `@pulumi/pulumi`'s location, and falls
 * back to its vendored 3.8.3 only when that `require` *throws*. TypeScript 7
 * imports fine but exposes no compiler API, so the fallback never fires and
 * ts-node dies on `ts.sys.readFile`.
 *
 * A tree with **no** TypeScript therefore fails inside a TS 7 repo, because
 * resolution walks up and finds 7. `policy:install` installs `typescript@5.9.3`
 * alongside the pack instead, with `--install-links` so npm copies rather than
 * symlinks — a symlink resolves through the real path and lands back in the
 * monorepo — and outside `node_modules/` so `npm ci` cannot wipe it.
 *
 * Those properties are asserted and mutation-tested in
 * `packages/gcp-components/test/policy/pack.test.ts`. Re-deriving them here
 * would mean two mechanisms to keep in step, and the quiet one would rot: a
 * pack that fails to load is silent, and the stack simply goes unenforced.
 */

const COMPONENTS = join(__dirname, "..", "..", "packages", "gcp-components");

/** Where `policy:install` puts the runnable pack. */
const PACK_DIR = join(
  COMPONENTS,
  ".runway-policy",
  "node_modules",
  "@runway",
  "gcp-components",
  "policy",
);

/**
 * Absolute path to a loadable pack, installing it if it is not there yet.
 *
 * Reinstalled only when absent. The install is a full `npm install` of four
 * packages and the pack is rebuilt from `lib/`, so a stale tree is possible
 * after a component change — run `npm run policy:install --workspace
 * @runway/gcp-components` to refresh it, which is what the CI workflow does
 * unconditionally.
 */
export const installedPolicyPack = (): string => {
  if (!existsSync(join(PACK_DIR, "PulumiPolicy.yaml"))) {
    execFileSync(
      "npm",
      ["run", "policy:install", "--workspace", "@runway/gcp-components"],
      { cwd: join(__dirname, "..", ".."), stdio: "pipe" },
    );
  }

  if (!existsSync(join(PACK_DIR, "PulumiPolicy.yaml"))) {
    throw new Error(
      `policy:install did not produce a pack at ${PACK_DIR}. Without it the ` +
        "preview runs unenforced, which reports as a pass.",
    );
  }

  return PACK_DIR;
};
