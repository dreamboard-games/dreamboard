import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Plugin } from "esbuild";
import { resolveCliRepoRoot } from "./repo-root.js";

type RepoLocalPackageInfo = {
  rootDir: string;
  exports: unknown;
};

type RepoLocalPackageResolutionOptions = {
  repoRoot?: string;
};

const PACKAGE_INFO_CACHE = new Map<string, Map<string, RepoLocalPackageInfo>>();

function normalizeRepoRoot(
  options?: RepoLocalPackageResolutionOptions,
): string {
  return options?.repoRoot ?? resolveCliRepoRoot(import.meta.url);
}

function readPackageInfos(repoRoot: string): Map<string, RepoLocalPackageInfo> {
  const cached = PACKAGE_INFO_CACHE.get(repoRoot);
  if (cached) {
    return cached;
  }

  const packageInfos = new Map<string, RepoLocalPackageInfo>();
  const addPackageInfo = (packageRoot: string): void => {
    const packageJsonPath = path.join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) {
      return;
    }

    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      exports?: unknown;
    };
    if (
      !parsed.name ||
      (!parsed.name.startsWith("@dreamboard/") &&
        !parsed.name.startsWith("@dreamboard-games/")) ||
      parsed.exports === undefined
    ) {
      return;
    }

    packageInfos.set(parsed.name, {
      rootDir: packageRoot,
      exports: parsed.exports,
    });
  };

  for (const workspaceDirName of ["packages", "apps"]) {
    const workspaceRoot = path.join(repoRoot, workspaceDirName);
    if (!existsSync(workspaceRoot)) {
      continue;
    }

    for (const entry of readdirSync(workspaceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      addPackageInfo(path.join(workspaceRoot, entry.name));
    }
  }

  for (const nodeModulesRoot of [
    path.join(repoRoot, "node_modules"),
    path.join(repoRoot, "apps", "dreamboard-cli", "node_modules"),
  ]) {
    for (const scopeName of ["@dreamboard", "@dreamboard-games"]) {
      const scopeRoot = path.join(nodeModulesRoot, scopeName);
      if (!existsSync(scopeRoot)) {
        continue;
      }

      for (const entry of readdirSync(scopeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }
        addPackageInfo(path.join(scopeRoot, entry.name));
      }
    }
  }

  PACKAGE_INFO_CACHE.set(repoRoot, packageInfos);
  return packageInfos;
}

function parseDreamboardPackageSpecifier(specifier: string): {
  packageName: string;
  subpath: string;
} | null {
  if (
    !specifier.startsWith("@dreamboard/") &&
    !specifier.startsWith("@dreamboard-games/")
  ) {
    return null;
  }

  const segments = specifier.split("/");
  if (segments.length < 2) {
    return null;
  }

  const packageName = `${segments[0]}/${segments[1]}`;
  const subpath =
    segments.length === 2 ? "." : `./${segments.slice(2).join("/")}`;
  return { packageName, subpath };
}

function resolveSourceTarget(exportEntry: unknown): string | null {
  if (typeof exportEntry === "string") {
    return exportEntry;
  }
  if (
    typeof exportEntry === "object" &&
    exportEntry !== null &&
    "dreamboard-source" in exportEntry &&
    typeof (exportEntry as { "dreamboard-source"?: unknown })[
      "dreamboard-source"
    ] === "string"
  ) {
    return (exportEntry as { "dreamboard-source": string })[
      "dreamboard-source"
    ];
  }
  if (
    typeof exportEntry === "object" &&
    exportEntry !== null &&
    "bun" in exportEntry &&
    typeof (exportEntry as { bun?: unknown }).bun === "string"
  ) {
    return (exportEntry as { bun: string }).bun;
  }
  if (
    typeof exportEntry === "object" &&
    exportEntry !== null &&
    "import" in exportEntry &&
    typeof (exportEntry as { import?: unknown }).import === "string"
  ) {
    return (exportEntry as { import: string }).import;
  }
  return null;
}

function resolveSourceTargetForSubpath(options: {
  exportsField: unknown;
  subpath: string;
}): string | null {
  if (
    typeof options.exportsField !== "object" ||
    options.exportsField === null ||
    Array.isArray(options.exportsField)
  ) {
    return options.subpath === "."
      ? resolveSourceTarget(options.exportsField)
      : null;
  }

  const exportsMap = options.exportsField as Record<string, unknown>;
  if (options.subpath === ".") {
    return (
      resolveSourceTarget(exportsMap["."]) ?? resolveSourceTarget(exportsMap)
    );
  }
  const exactTarget = resolveSourceTarget(exportsMap[options.subpath]);
  if (exactTarget) {
    return exactTarget;
  }

  const wildcardEntries = Object.entries(exportsMap)
    .filter(([key]) => key.includes("*"))
    .sort(([left], [right]) => right.length - left.length);
  for (const [pattern, exportEntry] of wildcardEntries) {
    const starIndex = pattern.indexOf("*");
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (
      !options.subpath.startsWith(prefix) ||
      !options.subpath.endsWith(suffix)
    ) {
      continue;
    }

    const wildcardValue = options.subpath.slice(
      prefix.length,
      options.subpath.length - suffix.length,
    );
    const targetPattern = resolveSourceTarget(exportEntry);
    if (!targetPattern) {
      continue;
    }
    return targetPattern.replace("*", wildcardValue);
  }

  return null;
}

export function resolveRepoLocalPackageSource(
  specifier: string,
  options?: RepoLocalPackageResolutionOptions,
): string | null {
  const parsedSpecifier = parseDreamboardPackageSpecifier(specifier);
  if (!parsedSpecifier) {
    return null;
  }

  let repoRoot: string;
  try {
    repoRoot = normalizeRepoRoot(options);
  } catch {
    return null;
  }

  const packageInfo = readPackageInfos(repoRoot).get(
    parsedSpecifier.packageName,
  );
  if (!packageInfo) {
    return null;
  }

  const sourceTarget = resolveSourceTargetForSubpath({
    exportsField: packageInfo.exports,
    subpath: parsedSpecifier.subpath,
  });
  if (!sourceTarget) {
    return null;
  }

  return path.join(packageInfo.rootDir, sourceTarget);
}

const cliPackageRequire = createRequire(import.meta.url);

function resolvableFromDirectory(
  specifier: string,
  directory: string,
): boolean {
  try {
    createRequire(path.join(directory, "noop.js")).resolve(specifier);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a `@dreamboard-games/*` specifier against the CLI package's own
 * dependency tree. This keeps manifest evaluation working in workspaces that
 * have not installed their dependencies yet (for example right after
 * `dreamboard clone`), where the installed CLI's pinned SDK is the only
 * available copy.
 */
function resolveCliBundledPackage(specifier: string): string | null {
  try {
    return cliPackageRequire.resolve(specifier);
  } catch {
    return null;
  }
}

export function createRepoLocalPackageResolutionPlugin(
  options?: RepoLocalPackageResolutionOptions,
): Plugin {
  return {
    name: "dreamboard-repo-local-package-resolution",
    setup(build) {
      build.onResolve({ filter: /^@dreamboard(?:-games)?\// }, (args) => {
        // Prefer the workspace's own installed copy when present; returning
        // null lets esbuild perform its normal node_modules resolution.
        if (resolvableFromDirectory(args.path, args.resolveDir)) {
          return null;
        }
        const resolvedPath = resolveRepoLocalPackageSource(args.path, options);
        if (resolvedPath) {
          return { path: resolvedPath };
        }
        const bundledPath = resolveCliBundledPackage(args.path);
        if (bundledPath) {
          return { path: bundledPath };
        }
        return null;
      });
    },
  };
}
