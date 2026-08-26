/**
 * EP-07: a service with no production environment is incomplete, and that is
 * a fact someone has read, not a state nobody noticed.
 *
 * A report, not a refusal — refusing would block the staging-first adoption
 * path the option exists to support. `runway bootstrap` prints this on every
 * run; this module owns which controls the absence leaves unenforced.
 */

export interface ServiceCompleteness {
  readonly complete: boolean;

  /**
   * The controls with nothing to enforce against while production is absent.
   * EP-04 and EP-05 are never here: they apply to staging from the first run.
   */
  readonly notEnforced: readonly string[];
}

export const serviceCompleteness = (options: {
  readonly production: boolean;
}): ServiceCompleteness =>
  options.production
    ? { complete: true, notEnforced: [] }
    : { complete: false, notEnforced: ["EP-01", "EP-02", "EP-03", "EP-06"] };
