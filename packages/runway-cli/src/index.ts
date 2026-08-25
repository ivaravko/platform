/**
 * Public surface of `@runway/cli`.
 *
 * The scaffolding project type and the CLI entry point are exported from here
 * as they are built.
 */

export {
  RunwayServiceProject,
  type RunwayServiceProjectOptions,
} from "./templates/runway-service-project";

/** Semantic version of the scaffolding contract this package emits. */
export const SCAFFOLD_CONTRACT_VERSION = "0.1.0";
