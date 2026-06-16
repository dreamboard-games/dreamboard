import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  buildDependencyPreparationFailureMessage,
  buildMissingDependencyToolingMessage,
  buildMissingGeneratedLockfileMessage,
  buildPackageLockConflictMessage,
} from "./dependency-tooling-messages.js";
import { FRAMEWORK_PNPM_OVERRIDES } from "./framework-dependencies.js";

type LockfileGenerationOptions = Record<string, never>;

type PackageJsonShape = {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  pnpm?: Record<string, unknown>;
};

type DependencyInstallMetadata = {
  dependencyFingerprint: string;
  installedAt: string;
  packageManager: string;
};

type LockfileCommand = {
  binary: string;
  args: string[];
};

export type WorkspaceDependencyReconciliationResult = {
  required: boolean;
  installed: boolean;
  lockfileGenerated: boolean;
  packageManagerNormalized: boolean;
  fingerprint: string | null;
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.resolve(MODULE_DIR, "../../..");
const REPO_ROOT = path.resolve(CLI_ROOT, "../..");
const REPO_PACKAGE_JSON_PATH = path.join(REPO_ROOT, "package.json");
const DEFAULT_PACKAGE_MANAGER = "pnpm@10.4.1";
const SDK_PACKAGE_NAME = "@dreamboard-games/sdk";
const SDK_REQUIRED_DIST_FILES = [
  "dist/index.d.ts",
  "dist/index.js",
  "dist/types.d.ts",
  "dist/types.js",
  "dist/ui.d.ts",
  "dist/ui.js",
  "dist/runtime.d.ts",
  "dist/runtime.js",
] as const;
const DEPENDENCY_INSTALL_METADATA_PATH_SEGMENTS = [
  ".dreamboard",
  "dependency-install.json",
] as const;

class LockfileGenerationError extends Error {
  constructor(
    readonly binary: string,
    readonly details: {
      code?: number | null;
      stdout: string;
      stderr: string;
      cause?: Error;
    },
  ) {
    super(buildLockfileGenerationErrorMessage(binary, details), {
      cause: details.cause,
    });
    this.name = "LockfileGenerationError";
  }
}

export async function generatePnpmLockfile(
  projectRoot: string,
  _options: LockfileGenerationOptions = {},
): Promise<boolean> {
  await ensurePackageManagerNormalized(projectRoot);
  await assertNoNpmLockfileConflict(projectRoot);
  await runPackageManagerCommand(projectRoot, {
    args: [
      "install",
      "--ignore-workspace",
      "--lockfile-only",
      "--config.shared-workspace-lockfile=false",
    ],
  });
  await assertPnpmLockfilePresent(projectRoot);
  return true;
}

export async function installWorkspaceDependencies(
  projectRoot: string,
  _options: LockfileGenerationOptions = {},
): Promise<boolean> {
  const result = await reconcileWorkspaceDependencies(projectRoot);
  return result.required;
}

export async function reconcileWorkspaceDependencies(
  projectRoot: string,
): Promise<WorkspaceDependencyReconciliationResult> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  if (!(await pathExists(packageJsonPath))) {
    return {
      required: false,
      installed: false,
      lockfileGenerated: false,
      packageManagerNormalized: false,
      fingerprint: null,
    };
  }

  await assertNoNpmLockfileConflict(projectRoot);
  const packageManagerNormalized =
    await ensurePackageManagerNormalized(projectRoot);
  const pnpmLockfilePath = path.join(projectRoot, "pnpm-lock.yaml");
  const nodeModulesPath = path.join(projectRoot, "node_modules");
  const metadataPath = path.join(
    projectRoot,
    ...DEPENDENCY_INSTALL_METADATA_PATH_SEGMENTS,
  );

  let lockfileGenerated = false;
  let installed = false;
  const metadata = await readJsonFile<DependencyInstallMetadata>(metadataPath);
  const lockfileExists = await pathExists(pnpmLockfilePath);

  if (!lockfileExists) {
    await runPackageManagerCommand(projectRoot, {
      args: [
        "install",
        "--ignore-workspace",
        "--config.shared-workspace-lockfile=false",
      ],
    });
    lockfileGenerated = true;
    installed = true;
  }

  await assertPnpmLockfilePresent(projectRoot);
  let fingerprint = await fingerprintInstallManifest({
    packageJsonPath,
    lockfilePath: pnpmLockfilePath,
  });
  const hasValidInstalledDeps =
    (await pathExists(nodeModulesPath)) &&
    (await hasValidInstalledDependencies({
      packageJsonPath,
      nodeModulesPath,
    }));
  const shouldInstall =
    !installed &&
    (metadata?.dependencyFingerprint !== fingerprint || !hasValidInstalledDeps);

  if (shouldInstall) {
    await rm(nodeModulesPath, { recursive: true, force: true });
    await runPackageManagerCommand(projectRoot, {
      args: [
        "install",
        "--ignore-workspace",
        "--config.shared-workspace-lockfile=false",
      ],
    });
    installed = true;
    fingerprint = await fingerprintInstallManifest({
      packageJsonPath,
      lockfilePath: pnpmLockfilePath,
    });
  }

  if (installed || packageManagerNormalized || !metadata) {
    await mkdir(path.dirname(metadataPath), { recursive: true });
    await writeJsonFile(metadataPath, {
      dependencyFingerprint: fingerprint,
      installedAt: new Date().toISOString(),
      packageManager: await readRepoPackageManager(),
    } satisfies DependencyInstallMetadata);
  }

  return {
    required: true,
    installed,
    lockfileGenerated,
    packageManagerNormalized,
    fingerprint,
  };
}

async function assertNoNpmLockfileConflict(projectRoot: string): Promise<void> {
  const packageLockPath = path.join(projectRoot, "package-lock.json");
  const pnpmLockPath = path.join(projectRoot, "pnpm-lock.yaml");
  if (
    (await pathExists(packageLockPath)) &&
    !(await pathExists(pnpmLockPath))
  ) {
    throw new Error(buildPackageLockConflictMessage());
  }
}

async function assertPnpmLockfilePresent(projectRoot: string): Promise<void> {
  const pnpmLockfilePath = path.join(projectRoot, "pnpm-lock.yaml");
  if (!(await pathExists(pnpmLockfilePath))) {
    throw new Error(buildMissingGeneratedLockfileMessage());
  }
}

async function ensurePackageManagerNormalized(
  projectRoot: string,
): Promise<boolean> {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJsonContent = await readFile(packageJsonPath, "utf8");
  const packageJson = JSON.parse(packageJsonContent) as PackageJsonShape;
  const packageManager = await readRepoPackageManager();
  const nextPackageJson: PackageJsonShape = {
    ...packageJson,
    packageManager,
    pnpm: mergePnpmConfig(packageJson.pnpm),
  };
  const normalizedPackageJson = `${JSON.stringify(nextPackageJson, null, 2)}\n`;
  if (normalizedPackageJson === packageJsonContent) {
    return false;
  }
  await writeFile(packageJsonPath, normalizedPackageJson, "utf8");
  return true;
}

function mergePnpmConfig(
  existingPnpm: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const existingOverrides =
    existingPnpm?.overrides &&
    typeof existingPnpm.overrides === "object" &&
    !Array.isArray(existingPnpm.overrides)
      ? (existingPnpm.overrides as Record<string, unknown>)
      : {};
  return {
    ...(existingPnpm ?? {}),
    overrides: {
      ...existingOverrides,
      ...FRAMEWORK_PNPM_OVERRIDES,
    },
  };
}

async function fingerprintInstallManifest(options: {
  packageJsonPath: string;
  lockfilePath: string;
}): Promise<string> {
  const packageJson = await readFile(options.packageJsonPath, "utf8");
  const lockfile = await readFile(options.lockfilePath, "utf8");
  const packageManager = await readRepoPackageManager();
  return fingerprintContent([
    packageJson,
    lockfile,
    `packageManager:${packageManager}`,
  ]);
}

async function hasValidInstalledDependencies(options: {
  packageJsonPath: string;
  nodeModulesPath: string;
}): Promise<boolean> {
  const packageJson = await readJsonFile<PackageJsonShape>(
    options.packageJsonPath,
  );
  if (!packageJson) {
    return false;
  }

  const directDependencyNames = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ] as const) {
    for (const packageName of Object.keys(packageJson[field] ?? {})) {
      directDependencyNames.add(packageName);
    }
  }

  if (directDependencyNames.size === 0) {
    return true;
  }

  for (const packageName of directDependencyNames) {
    const packageRoot = path.join(
      options.nodeModulesPath,
      ...packageName.split("/"),
    );
    if (!(await pathExists(path.join(packageRoot, "package.json")))) {
      return false;
    }
    if (
      packageName === SDK_PACKAGE_NAME &&
      !(await hasInstalledSdkDistFiles(packageRoot))
    ) {
      return false;
    }
  }

  return true;
}

async function hasInstalledSdkDistFiles(packageRoot: string): Promise<boolean> {
  for (const relativePath of SDK_REQUIRED_DIST_FILES) {
    if (!(await pathExists(path.join(packageRoot, relativePath)))) {
      return false;
    }
  }
  return true;
}

function hasExactPnpmVersion(value?: string): boolean {
  return /^pnpm@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value ?? "");
}

async function readRepoPackageManager(): Promise<string> {
  const packageJson = await readJsonFile<PackageJsonShape>(
    REPO_PACKAGE_JSON_PATH,
  );
  const packageManager = packageJson?.packageManager?.trim();
  return hasExactPnpmVersion(packageManager)
    ? packageManager!
    : DEFAULT_PACKAGE_MANAGER;
}

function fingerprintContent(parts: string[]): string {
  return crypto
    .createHash("sha256")
    .update(parts.join("\n---\n"))
    .digest("hex");
}

function resolvePnpmInstallInvocation(installArgs: readonly string[]): {
  command: string;
  args: string[];
} {
  const corepackPath = path.join(path.dirname(process.execPath), "corepack");
  if (existsSync(corepackPath)) {
    return { command: corepackPath, args: ["pnpm", ...installArgs] };
  }
  return { command: "pnpm", args: [...installArgs] };
}

async function runPackageManagerCommand(
  projectRoot: string,
  command: { args: string[] },
): Promise<void> {
  const invocation = resolvePnpmInstallInvocation(command.args);
  await runLockfileCommand(projectRoot, {
    binary: invocation.command,
    args: invocation.args,
  });
}

async function runLockfileCommand(
  projectRoot: string,
  command: LockfileCommand,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command.binary, command.args, {
      cwd: projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    bindStream(child.stdout, (chunk) => {
      stdout += chunk.toString();
    });
    bindStream(child.stderr, (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (cause) => {
      reject(
        new LockfileGenerationError(command.binary, {
          stdout,
          stderr,
          cause,
        }),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new LockfileGenerationError(command.binary, {
          code,
          stdout,
          stderr,
        }),
      );
    });
  });
}

function buildLockfileGenerationErrorMessage(
  binary: string,
  details: {
    code?: number | null;
    stdout: string;
    stderr: string;
    cause?: Error;
  },
): string {
  if (details.cause) {
    const errnoError = details.cause as NodeJS.ErrnoException;
    const binaryName = path.basename(binary).toLowerCase();
    if (
      errnoError.code === "ENOENT" &&
      (binaryName === "pnpm" ||
        binaryName === "pnpm.cmd" ||
        binaryName === "corepack" ||
        binaryName === "corepack.exe")
    ) {
      return buildMissingDependencyToolingMessage();
    }
    return `Failed to start ${binary} for Dreamboard dependency reconciliation. ${details.cause.message}`;
  }

  const output = [details.stdout.trim(), details.stderr.trim()]
    .filter((chunk) => chunk.length > 0)
    .join("\n");

  return buildDependencyPreparationFailureMessage({
    exitCode: details.code,
    output,
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function bindStream(
  stream: Readable | EventEmitter | null | undefined,
  onData: (chunk: Buffer | string) => void,
): void {
  stream?.on("data", onData);
}
