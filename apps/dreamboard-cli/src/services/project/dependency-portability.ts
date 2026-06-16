import path from "node:path";
import type { ProjectConfig } from "../../types.js";
import { readJsonFile, readTextFileIfExists } from "../../utils/fs.js";

type PackageJsonWithDeps = {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pnpm?: {
    overrides?: Record<string, unknown>;
    [key: string]: unknown;
  };
};

export type SourceDependencyProfile = {
  kind: "npm-registry";
  packageManager?: string;
  dreamboardRegistryUrl?: string;
  localSnapshotId?: string;
  packages: Record<string, string>;
};

type DependencyProblem = {
  location: string;
  packageName: string;
  specifier: string;
};

type LegacyDependencyProblem = {
  location: string;
  packageName: string;
};

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const UNPORTABLE_SPECIFIER_PATTERN = /^(file|link|portal|workspace):/;

export async function buildSourceDependencyProfile(options: {
  projectRoot: string;
  projectConfig?: ProjectConfig;
}): Promise<SourceDependencyProfile> {
  const packageJson = await readProjectPackageJson(options.projectRoot);
  const packages = collectDreamboardPackageSpecifiers(packageJson);
  const hasLocalSnapshotPackage = Object.values(packages).some((value) =>
    value.includes("-local."),
  );
  const localMaintainerRegistry = hasLocalSnapshotPackage
    ? options.projectConfig?.localMaintainerRegistry
    : undefined;
  return {
    kind: "npm-registry",
    packageManager: packageJson.packageManager,
    dreamboardRegistryUrl:
      (await readDreamboardRegistryFromNpmrc(options.projectRoot)) ??
      localMaintainerRegistry?.registryUrl,
    localSnapshotId: localMaintainerRegistry?.snapshotId,
    packages,
  };
}

export async function assertCompilerPortableDependencies(options: {
  projectRoot: string;
  projectConfig?: ProjectConfig;
}): Promise<SourceDependencyProfile> {
  const packageJson = await readProjectPackageJson(options.projectRoot);
  const legacyProblems = collectLegacyDreamboardSpecifiers(packageJson);
  if (legacyProblems.length > 0) {
    throwLegacyDreamboardPackageError(legacyProblems);
  }

  const problems = collectUnportableDreamboardSpecifiers(packageJson);
  if (problems.length > 0) {
    const details = problems
      .map(
        (problem) =>
          `${problem.location} ${problem.packageName} -> ${problem.specifier}`,
      )
      .join("; ");
    throw new Error(
      [
        "Compiler-bound workspaces must install Dreamboard packages from a registry.",
        `Found unportable Dreamboard dependency specifier(s): ${details}.`,
        "Run `dreamboard sync` from a workspace that uses registry-pinned @dreamboard-games/* and dreamboard versions before compiling.",
      ].join(" "),
    );
  }

  const profile = await buildSourceDependencyProfile(options);
  const hasLocalSnapshotPackage = Object.values(profile.packages).some(
    (value) => value.includes("-local."),
  );
  if (hasLocalSnapshotPackage && !profile.dreamboardRegistryUrl) {
    throw new Error(
      "This workspace references local Dreamboard snapshot versions but has no @dreamboard registry configured. Run `dreamboard sync --env local` to refresh .npmrc before compiling.",
    );
  }

  return profile;
}

export async function assertReleaseEnvironmentPortableDependencies(options: {
  projectRoot: string;
  projectConfig?: ProjectConfig;
  environment: string;
}): Promise<SourceDependencyProfile> {
  const packageJson = await readProjectPackageJson(options.projectRoot);
  const legacyProblems = collectLegacyDreamboardSpecifiers(packageJson);
  if (legacyProblems.length > 0) {
    throwLegacyDreamboardPackageError(legacyProblems);
  }

  const profile = await buildSourceDependencyProfile(options);
  if (!isReleaseEnvironment(options.environment)) {
    return profile;
  }

  const localPackages = Object.entries(profile.packages).filter(([, version]) =>
    version.includes("-local."),
  );
  const localRegistryUrl = isLocalRegistryUrl(profile.dreamboardRegistryUrl)
    ? profile.dreamboardRegistryUrl
    : undefined;

  if (localPackages.length === 0 && !localRegistryUrl) {
    return profile;
  }

  const packageDetails = localPackages
    .map(([name, version]) => `${name}@${version}`)
    .join(", ");
  const registryDetails = localRegistryUrl
    ? `local registry ${localRegistryUrl}`
    : null;
  const details = [packageDetails || null, registryDetails]
    .filter(Boolean)
    .join("; ");

  throw new Error(
    [
      `The ${options.environment} environment does not support local Dreamboard package snapshots.`,
      `Found ${details}.`,
      "Publish a public alpha package, repin the workspace to that exact version, and rerun the command.",
    ].join(" "),
  );
}

async function readProjectPackageJson(
  projectRoot: string,
): Promise<PackageJsonWithDeps> {
  return readJsonFile<PackageJsonWithDeps>(
    path.join(projectRoot, "package.json"),
  );
}

function collectDreamboardPackageSpecifiers(
  packageJson: PackageJsonWithDeps,
): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!dependencies) continue;
    for (const [packageName, specifier] of Object.entries(dependencies)) {
      if (isPortableDreamboardPackage(packageName)) {
        packages[packageName] = specifier;
      }
    }
  }

  const overrides = packageJson.pnpm?.overrides;
  if (overrides) {
    for (const [packageName, specifier] of Object.entries(overrides)) {
      if (
        isPortableDreamboardPackage(packageName) &&
        typeof specifier === "string" &&
        packages[packageName] === undefined
      ) {
        packages[packageName] = specifier;
      }
    }
  }
  return packages;
}

function collectUnportableDreamboardSpecifiers(
  packageJson: PackageJsonWithDeps,
): DependencyProblem[] {
  const problems: DependencyProblem[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!dependencies) continue;
    for (const [packageName, specifier] of Object.entries(dependencies)) {
      if (
        isPortableDreamboardPackage(packageName) &&
        UNPORTABLE_SPECIFIER_PATTERN.test(specifier)
      ) {
        problems.push({ location: field, packageName, specifier });
      }
    }
  }

  const overrides = packageJson.pnpm?.overrides;
  if (overrides) {
    for (const [packageName, specifier] of Object.entries(overrides)) {
      if (
        isPortableDreamboardPackage(packageName) &&
        typeof specifier === "string" &&
        UNPORTABLE_SPECIFIER_PATTERN.test(specifier)
      ) {
        problems.push({
          location: "pnpm.overrides",
          packageName,
          specifier,
        });
      }
    }
  }
  return problems;
}

function collectLegacyDreamboardSpecifiers(
  packageJson: PackageJsonWithDeps,
): LegacyDependencyProblem[] {
  const problems: LegacyDependencyProblem[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!dependencies) continue;
    for (const packageName of Object.keys(dependencies)) {
      if (isLegacyDreamboardPackage(packageName)) {
        problems.push({ location: field, packageName });
      }
    }
  }

  const overrides = packageJson.pnpm?.overrides;
  if (overrides) {
    for (const packageName of Object.keys(overrides)) {
      if (isLegacyDreamboardPackage(packageName)) {
        problems.push({ location: "pnpm.overrides", packageName });
      }
    }
  }
  return problems;
}

function throwLegacyDreamboardPackageError(
  problems: LegacyDependencyProblem[],
): never {
  const details = problems
    .map((problem) => `${problem.location} ${problem.packageName}`)
    .join("; ");
  throw new Error(
    [
      "Legacy @dreamboard/* package dependencies are no longer supported in compiler-bound workspaces.",
      `Found ${details}.`,
      "Repin to the public @dreamboard-games/* packages and rerun the command.",
    ].join(" "),
  );
}

function isPortableDreamboardPackage(packageName: string): boolean {
  return (
    packageName === "dreamboard" ||
    packageName.startsWith("@dreamboard-games/")
  );
}

function isLegacyDreamboardPackage(packageName: string): boolean {
  return packageName.startsWith("@dreamboard/");
}

function isReleaseEnvironment(environment: string): boolean {
  return environment === "staging" || environment === "prod";
}

function isLocalRegistryUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1" ||
      url.hostname.endsWith(".local")
    );
  } catch {
    return /localhost|127\.0\.0\.1|\.local\b/.test(rawUrl);
  }
}

async function readDreamboardRegistryFromNpmrc(
  projectRoot: string,
): Promise<string | undefined> {
  const npmrc = await readTextFileIfExists(path.join(projectRoot, ".npmrc"));
  if (!npmrc) return undefined;
  for (const line of npmrc.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("@dreamboard-games:registry=")) continue;
    return (
      trimmed.slice("@dreamboard-games:registry=".length).trim() || undefined
    );
  }
  return undefined;
}
