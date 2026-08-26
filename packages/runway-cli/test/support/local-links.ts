/**
 * Run a scaffold-and-install test against the workspace copies of `@runway/*`
 * rather than the published ones.
 *
 * The build-out tests are the gate that matters — they run a real `npm install`
 * and `npm run build` on a generated repo. Since E9 the scaffold resolves
 * `@runway/cli` and `@runway/gcp-components` from Artifact Registry, which needs
 * Google credentials the platform's own CI does not have. Gating a unit tier on
 * GCP auth would be the wrong trade: the tier would go red for a reason that has
 * nothing to do with the code under test.
 *
 * So these tests link the local packages, and what they prove is narrower than
 * it looks: **the scaffold builds, not that the published versions resolve.**
 * That second claim belongs to `test-integration/preview/generated-repo.test.ts`,
 * which already requires credentials and installs from the registry for real.
 * Stated here because the gap is easy to forget once every test is green.
 */
export const withLocalPackages = <T>(body: () => T): T => {
  const previous = process.env.RUNWAY_LINK_LOCAL_PACKAGES;
  process.env.RUNWAY_LINK_LOCAL_PACKAGES = "1";
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env.RUNWAY_LINK_LOCAL_PACKAGES;
    else process.env.RUNWAY_LINK_LOCAL_PACKAGES = previous;
  }
};
