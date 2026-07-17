import path from "node:path";
import { readJsonFile } from "../../utils/fs.js";

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
  packages: Record<string, string>;
};

type DependencyProblem = {
  location: string;
  packageName: string;
  specifier: string;
};

type UnsupportedNamespaceProblem = {
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
}): Promise<SourceDependencyProfile> {
  const packageJson = await readProjectPackageJson(options.projectRoot);
  return {
    kind: "npm-registry",
    packageManager: packageJson.packageManager,
    packages: collectDreamboardPackageSpecifiers(packageJson),
  };
}

export async function assertCompilerPortableDependencies(options: {
  projectRoot: string;
}): Promise<SourceDependencyProfile> {
  const packageJson = await readProjectPackageJson(options.projectRoot);
  const namespaceProblems = collectUnsupportedDreamboardNamespaces(packageJson);
  if (namespaceProblems.length > 0) {
    throwUnsupportedDreamboardNamespaceError(namespaceProblems);
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
        "Use a workspace created or cloned with the current Dreamboard CLI so @dreamboard-games/* and dreamboard versions are registry-pinned before building.",
      ].join(" "),
    );
  }

  const profile = await buildSourceDependencyProfile(options);
  const localPackages = Object.entries(profile.packages).filter(([, version]) =>
    version.includes("-local."),
  );
  if (localPackages.length > 0) {
    const details = localPackages
      .map(([name, version]) => `${name}@${version}`)
      .join(", ");
    throw new Error(
      [
        "Local Dreamboard package snapshots are no longer supported.",
        `Found ${details}.`,
        "Publish a public alpha package, repin the workspace to that exact version, and rerun the command.",
      ].join(" "),
    );
  }

  return profile;
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

function collectUnsupportedDreamboardNamespaces(
  packageJson: PackageJsonWithDeps,
): UnsupportedNamespaceProblem[] {
  const problems: UnsupportedNamespaceProblem[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!dependencies) continue;
    for (const packageName of Object.keys(dependencies)) {
      if (isUnsupportedDreamboardNamespace(packageName)) {
        problems.push({ location: field, packageName });
      }
    }
  }

  const overrides = packageJson.pnpm?.overrides;
  if (overrides) {
    for (const packageName of Object.keys(overrides)) {
      if (isUnsupportedDreamboardNamespace(packageName)) {
        problems.push({ location: "pnpm.overrides", packageName });
      }
    }
  }
  return problems;
}

function throwUnsupportedDreamboardNamespaceError(
  problems: UnsupportedNamespaceProblem[],
): never {
  const details = problems
    .map((problem) => `${problem.location} ${problem.packageName}`)
    .join("; ");
  throw new Error(
    [
      "The @dreamboard/* package namespace is not supported in compiler-bound workspaces.",
      `Found ${details}.`,
      "Repin to the public @dreamboard-games/* packages and rerun the command.",
    ].join(" "),
  );
}

function isPortableDreamboardPackage(packageName: string): boolean {
  return (
    packageName === "dreamboard" || packageName.startsWith("@dreamboard-games/")
  );
}

function isUnsupportedDreamboardNamespace(packageName: string): boolean {
  return packageName.startsWith("@dreamboard/");
}
