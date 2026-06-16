#!/usr/bin/env tsx
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildInstalledCliLocalMaintainerSnapshot } from "../src/services/project/local-maintainer-registry.js";
import {
  LOCAL_REGISTRY_URL,
  readWorkspaceLocalMaintainerRegistryFromPackageJson,
} from "../src/services/project/local-maintainer-registry-shared.js";

const command = process.argv[2];

if (command === "ensure-snapshot") {
  const packageJson = JSON.parse(
    readFileSync(path.resolve("package.json"), "utf8"),
  ) as {
    dependencies?: Record<string, unknown>;
  };
  const registryUrl =
    process.env.DREAMBOARD_LOCAL_REGISTRY_URL?.trim() || LOCAL_REGISTRY_URL;

  console.log(
    JSON.stringify(
      buildInstalledCliLocalMaintainerSnapshot(packageJson, registryUrl),
    ),
  );
} else if (command === "read-workspace") {
  const projectRoot = optionValue("--project-root");
  if (!projectRoot) {
    console.error("Missing required --project-root option.");
    process.exit(1);
  }
  const fallbackRegistryUrl =
    optionValue("--fallback-registry-url") ||
    process.env.DREAMBOARD_LOCAL_REGISTRY_URL?.trim() ||
    LOCAL_REGISTRY_URL;

  console.log(
    JSON.stringify(
      await readWorkspaceLocalMaintainerRegistryFromPackageJson(
        projectRoot,
        fallbackRegistryUrl,
      ),
    ),
  );
} else {
  console.error(`Unknown local maintainer registry command: ${command ?? ""}`);
  process.exit(1);
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}
