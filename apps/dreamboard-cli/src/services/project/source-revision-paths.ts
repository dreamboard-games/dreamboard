import { RULE_FILE } from "../../constants.js";
import {
  isAllowedGamePath,
  isDynamicGeneratedPath,
} from "./scaffold-ownership.js";

/**
 * Single definition of what belongs in an uploaded source revision, shared by
 * `dev` and `sync`. The compiler consumes the uploaded workspace as-is and
 * does not regenerate codegen outputs, so dynamic generated files (manifest
 * contract, ui-contract, framework tsconfigs) must always be included.
 */
export function isSourceRevisionPath(filePath: string): boolean {
  return filePath !== RULE_FILE && isAllowedGamePath(filePath);
}

/**
 * Files that must be upserted on every sync even when the local diff reports
 * them unchanged: registry configuration and regenerated codegen outputs.
 */
export function shouldAlwaysUpsertSourcePath(filePath: string): boolean {
  return filePath === ".npmrc" || isDynamicGeneratedPath(filePath);
}
