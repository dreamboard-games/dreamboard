import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function isRepoRoot(candidate: string): boolean {
  return (
    existsSync(path.join(candidate, "pnpm-workspace.yaml")) &&
    existsSync(path.join(candidate, "apps", "dreamboard-cli", "package.json"))
  );
}

export function resolveCliRepoRoot(importMetaUrl: string = import.meta.url) {
  let current = path.dirname(fileURLToPath(importMetaUrl));

  while (true) {
    if (isRepoRoot(current)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new Error(
    `Could not resolve Dreamboard CLI repo root from ${importMetaUrl}.`,
  );
}
