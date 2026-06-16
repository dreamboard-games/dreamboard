import { SCAFFOLD_OWNERSHIP } from "./scaffold-ownership.generated.js";
import { normalizeOwnedProjectPath } from "./workspace-path.js";
export { normalizeOwnedProjectPath } from "./workspace-path.js";

export function isAllowedGamePath(filePath: string): boolean {
  const path = normalizeOwnedProjectPath(filePath);
  if (path === null) return false;
  if (SCAFFOLD_OWNERSHIP.allowedPaths.rootFiles.includes(path)) return true;
  return SCAFFOLD_OWNERSHIP.allowedPaths.directoryPrefixes.some((prefix) =>
    path.startsWith(prefix),
  );
}

export function isDynamicGeneratedPath(filePath: string): boolean {
  const path = normalizeOwnedProjectPath(filePath);
  if (path === null) return false;
  return SCAFFOLD_OWNERSHIP.dynamic.generatedFiles.includes(path);
}

export function isDynamicSeedPath(filePath: string): boolean {
  const path = normalizeOwnedProjectPath(filePath);
  if (path === null) return false;
  if (SCAFFOLD_OWNERSHIP.dynamic.seedFiles.includes(path)) return true;
  return SCAFFOLD_OWNERSHIP.dynamic.seedFilePatterns.some(
    (pattern) =>
      path.startsWith(pattern.prefix) && path.endsWith(pattern.suffix),
  );
}

export function isCliStaticPath(filePath: string): boolean {
  const path = normalizeOwnedProjectPath(filePath);
  if (path === null) return false;
  if (SCAFFOLD_OWNERSHIP.cliStatic.exactFiles.includes(path)) return true;
  return SCAFFOLD_OWNERSHIP.cliStatic.directoryPrefixes.some((prefix) =>
    path.startsWith(prefix),
  );
}

/**
 * Library files are always-managed scaffold files (dynamic generated or CLI static).
 */
export function isLibraryPath(filePath: string): boolean {
  return isDynamicGeneratedPath(filePath) || isCliStaticPath(filePath);
}

export const PRESERVED_USER_FILES = new Set(
  SCAFFOLD_OWNERSHIP.preservedUserFiles,
);
