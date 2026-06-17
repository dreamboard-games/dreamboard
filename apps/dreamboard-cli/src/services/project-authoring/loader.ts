import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  ProjectAuthoringError,
  type LoadedProjectAuthoringAdapterV1,
} from "./contract.js";
import { validateProjectAuthoringAdapter } from "./validation.js";

type PackageJson = {
  name?: string;
  version?: string;
  exports?: unknown;
};

type ResolvedProjectAuthoringAdapter = {
  packageJsonPath: string;
  adapterPath: string;
};

const PROJECT_SDK_RESOLUTION_RETRY_DELAYS_MS = [50, 150, 300] as const;

function problemFromResolveError(error: unknown): ProjectAuthoringError {
  if (error instanceof ProjectAuthoringError) {
    return error;
  }
  const code =
    (error as NodeJS.ErrnoException | undefined)?.code ===
    "ERR_PACKAGE_PATH_NOT_EXPORTED"
      ? "AUTHORING_ADAPTER_NOT_EXPORTED"
      : "SDK_NOT_INSTALLED";
  return new ProjectAuthoringError(
    code,
    code === "AUTHORING_ADAPTER_NOT_EXPORTED"
      ? "Installed @dreamboard-games/sdk does not export @dreamboard-games/sdk/authoring."
      : "Install @dreamboard-games/sdk in this workspace before running authoring commands.",
  );
}

function assertResolvedInsidePackage(options: {
  packageRoot: string;
  resolvedPath: string;
  label: string;
}): void {
  const packageRoot = path.resolve(options.packageRoot);
  const resolvedPath = path.resolve(options.resolvedPath);
  const relative = path.relative(packageRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ProjectAuthoringError(
      "AUTHORING_ADAPTER_NOT_EXPORTED",
      `${options.label} resolved outside the installed @dreamboard-games/sdk package.`,
    );
  }
}

function isAuthoringMetadataVersionCompatible(options: {
  metadataVersion: string;
  packageVersion: string;
}): boolean {
  if (options.metadataVersion === options.packageVersion) {
    return true;
  }
  return options.packageVersion.startsWith(`${options.metadataVersion}-local.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveExportTarget(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const condition of ["import", "default"]) {
    const resolved = resolveExportTarget(value[condition]);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

async function resolveDirectProjectAuthoringAdapter(
  projectRoot: string,
): Promise<ResolvedProjectAuthoringAdapter | null> {
  const packageRoot = path.join(
    projectRoot,
    "node_modules",
    "@dreamboard-games",
    "sdk",
  );
  const packageJsonPath = path.join(packageRoot, "package.json");
  let packageJson: PackageJson;
  try {
    packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;
  } catch {
    return null;
  }
  const authoringExport = isRecord(packageJson.exports)
    ? resolveExportTarget(packageJson.exports["./authoring"])
    : null;
  if (!authoringExport) {
    throw new ProjectAuthoringError(
      "AUTHORING_ADAPTER_NOT_EXPORTED",
      "Installed @dreamboard-games/sdk does not export @dreamboard-games/sdk/authoring.",
    );
  }
  const adapterPath = path.resolve(packageRoot, authoringExport);
  assertResolvedInsidePackage({
    packageRoot,
    resolvedPath: adapterPath,
    label: "@dreamboard-games/sdk/authoring",
  });
  return { packageJsonPath, adapterPath };
}

async function resolveProjectAuthoringAdapter(
  projectRoot: string,
): Promise<ResolvedProjectAuthoringAdapter> {
  const requireFromProject = createRequire(path.join(projectRoot, "package.json"));
  let lastError: unknown;

  for (
    let attempt = 0;
    attempt <= PROJECT_SDK_RESOLUTION_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      const packageJsonPath = requireFromProject.resolve(
        "@dreamboard-games/sdk/package.json",
      );
      const adapterPath = requireFromProject.resolve(
        "@dreamboard-games/sdk/authoring",
      );
      return { packageJsonPath, adapterPath };
    } catch (error) {
      lastError = error;
      if (
        (error as NodeJS.ErrnoException | undefined)?.code ===
        "ERR_PACKAGE_PATH_NOT_EXPORTED"
      ) {
        throw error;
      }
      const directResolved =
        await resolveDirectProjectAuthoringAdapter(projectRoot);
      if (directResolved) {
        return directResolved;
      }
      const retryDelay = PROJECT_SDK_RESOLUTION_RETRY_DELAYS_MS[attempt];
      if (retryDelay === undefined) {
        break;
      }
      await delay(retryDelay);
    }
  }

  throw lastError;
}

export async function loadProjectAuthoringAdapter(
  projectRoot: string,
): Promise<LoadedProjectAuthoringAdapterV1> {
  let packageJsonPath: string;
  let adapterPath: string;
  try {
    ({ packageJsonPath, adapterPath } =
      await resolveProjectAuthoringAdapter(projectRoot));
  } catch (error) {
    throw problemFromResolveError(error);
  }

  const packageRoot = path.dirname(packageJsonPath);
  assertResolvedInsidePackage({
    packageRoot,
    resolvedPath: adapterPath,
    label: "@dreamboard-games/sdk/authoring",
  });

  const packageJson = JSON.parse(
    await readFile(packageJsonPath, "utf8"),
  ) as PackageJson;
  if (
    packageJson.name !== "@dreamboard-games/sdk" ||
    typeof packageJson.version !== "string" ||
    packageJson.version.trim().length === 0
  ) {
    throw new ProjectAuthoringError(
      "SDK_METADATA_MISMATCH",
      "Installed SDK package metadata is invalid.",
    );
  }

  const moduleRecord = (await import(pathToFileURL(adapterPath).href)) as {
    projectAuthoringAdapter?: unknown;
    default?: unknown;
  };
  const adapter = validateProjectAuthoringAdapter(
    moduleRecord.projectAuthoringAdapter ?? moduleRecord.default,
  );
  if (
    !isAuthoringMetadataVersionCompatible({
      metadataVersion: adapter.metadata.sdkVersion,
      packageVersion: packageJson.version,
    })
  ) {
    throw new ProjectAuthoringError(
      "SDK_METADATA_MISMATCH",
      `SDK authoring adapter reports version ${adapter.metadata.sdkVersion}, but package metadata is ${packageJson.version}.`,
    );
  }

  return {
    packageRoot,
    packageVersion: packageJson.version,
    adapterPath,
    adapter,
  };
}
