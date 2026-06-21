import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { DevHostModuleV1 } from "./contract.js";

export type LoadedDevHostModuleV1 = {
  packageRoot: string;
  packageVersion: string;
  module: DevHostModuleV1;
};

type DevHostPackageJson = {
  name?: string;
  version?: string;
  main?: string;
};

export async function loadProjectDevHost(
  projectRoot: string,
): Promise<LoadedDevHostModuleV1> {
  const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
  let packageJsonPath: string;

  try {
    packageJsonPath = requireFromProject.resolve(
      "@dreamboard-games/dev-host/package.json",
    );
  } catch (error) {
    throw new Error(
      "Install @dreamboard-games/dev-host in this workspace before running dreamboard dev or browser tests.",
      { cause: error },
    );
  }

  const packageRoot = path.dirname(packageJsonPath);
  const packageJson = requireFromProject(packageJsonPath) as DevHostPackageJson;
  if (
    packageJson.name !== "@dreamboard-games/dev-host" ||
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error("Installed @dreamboard-games/dev-host metadata is invalid.");
  }
  const entryPath = path.resolve(packageRoot, packageJson.main ?? "dist/index.js");
  if (!isPathInside(packageRoot, entryPath)) {
    throw new Error(
      "@dreamboard-games/dev-host resolved outside its installed package.",
    );
  }

  const loaded = (await import(pathToFileURL(entryPath).href)) as Partial<
    DevHostModuleV1
  >;
  if (loaded.protocolVersion !== 1 || typeof loaded.start !== "function") {
    throw new Error(
      "Installed @dreamboard-games/dev-host does not expose DevHostModuleV1.",
    );
  }

  return {
    packageRoot,
    packageVersion: packageJson.version,
    module: {
      protocolVersion: loaded.protocolVersion,
      start: loaded.start,
    },
  };
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = path.relative(parent, candidate);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}
