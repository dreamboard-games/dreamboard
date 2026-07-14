import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LocalMaintainerRegistryConfig } from "../../types.js";
import { resolveCliRepoRoot } from "../../utils/repo-root.js";
import {
  LOCAL_REGISTRY_URL,
  didLocalMaintainerSnapshotChange,
  getLocalMaintainerNpmrcContent,
  isLocalMaintainerRegistryEnabled,
  isLocalMaintainerRegistryUrl,
  shortHash,
} from "./local-maintainer-registry-shared.js";

export {
  didLocalMaintainerSnapshotChange,
  getLocalMaintainerNpmrcContent,
  isLocalMaintainerRegistryEnabled,
  isLocalMaintainerRegistryUrl,
};

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

function getCliPackageRoot(): string {
  try {
    return path.join(
      resolveCliRepoRoot(import.meta.url),
      "apps",
      "dreamboard-cli",
    );
  } catch {
    return resolveInstalledCliPackageRoot(MODULE_DIR);
  }
}

function resolveInstalledCliPackageRoot(moduleDir: string): string {
  let current = moduleDir;
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(
          readFileSync(packageJsonPath, "utf8"),
        ) as { name?: unknown };
        if (
          packageJson.name === "@dreamboard-games/cli" ||
          packageJson.name === "dreamboard" ||
          packageJson.name === "dreamboard-cli"
        ) {
          return current;
        }
      } catch {
        // Keep walking upward; a malformed parent package should not hide the
        // installed CLI package root.
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return moduleDir;
    }
    current = parent;
  }
}

function getScriptInvocation(): {
  command: string;
  args: string[];
  attemptedCommand: string;
  cwd: string;
} {
  const cliPackageRoot = getCliPackageRoot();
  const scriptPath = getLocalMaintainerScriptPath(cliPackageRoot);
  if (!existsSync(scriptPath)) {
    throw new Error(
      [
        "Dreamboard local maintainer registry support is only available from a source checkout.",
        `Expected helper script at ${scriptPath}.`,
      ].join(" "),
    );
  }

  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const args = ["exec", "tsx", scriptPath];
  return {
    command,
    args,
    attemptedCommand: `${command} ${args.join(" ")}`,
    cwd: cliPackageRoot,
  };
}

function getLocalMaintainerScriptPath(cliPackageRoot: string): string {
  return path.join(cliPackageRoot, "scripts", "local-maintainer-registry.ts");
}

function isInstalledCliPackageRoot(cliPackageRoot: string): boolean {
  return cliPackageRoot.split(path.sep).includes("node_modules");
}

function shouldSkipLocalMaintainerHelper(): boolean {
  const cliPackageRoot = getCliPackageRoot();
  const scriptPath = getLocalMaintainerScriptPath(cliPackageRoot);
  return !existsSync(scriptPath) && isInstalledCliPackageRoot(cliPackageRoot);
}

export function buildInstalledCliLocalMaintainerSnapshot(
  packageJson: { dependencies?: Record<string, unknown> },
  registryUrl: string = LOCAL_REGISTRY_URL,
): LocalMaintainerRegistryConfig | null {
  const sdkVersion = packageJson.dependencies?.["@dreamboard-games/sdk"];
  if (typeof sdkVersion !== "string" || !sdkVersion.includes("-local.")) {
    return null;
  }

  return {
    registryUrl,
    snapshotId: shortHash(sdkVersion),
    fingerprint: shortHash(sdkVersion),
    publishedAt: "",
    packages: {
      "@dreamboard-games/sdk": sdkVersion,
    },
  };
}

export function readInstalledCliLocalMaintainerSnapshot(): LocalMaintainerRegistryConfig | null {
  const cliPackageRoot = getCliPackageRoot();
  if (!isInstalledCliPackageRoot(cliPackageRoot)) {
    return null;
  }

  const packageJsonPath = path.join(cliPackageRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return null;
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, unknown>;
  };
  return buildInstalledCliLocalMaintainerSnapshot(packageJson);
}

function buildScriptSetupError(options: {
  attemptedCommand: string;
  message: string;
  stderr?: string;
}): Error {
  return new Error(
    [
      "Dreamboard local maintainer registry support requires the source-checkout CLI tooling.",
      options.message,
      `Attempted command: ${options.attemptedCommand}`,
      options.stderr?.trim() ? `stderr:\n${options.stderr.trim()}` : null,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

function parseJsonPayload<T>(output: string): T {
  const payload = output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .reverse()
    .find(
      (line) => line === "null" || line.startsWith("{") || line.startsWith("["),
    );

  if (!payload) {
    throw new Error("completed without returning a JSON payload");
  }

  return JSON.parse(payload) as T;
}

async function runLocalMaintainerScript<T>(args: string[]): Promise<T> {
  const invocation = getScriptInvocation();

  return new Promise<T>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      const errnoError = error as NodeJS.ErrnoException;
      if (errnoError.code === "ENOENT") {
        reject(
          buildScriptSetupError({
            attemptedCommand: invocation.attemptedCommand,
            message:
              "`pnpm` was not found on PATH, so the source-checkout local maintainer helper could not run.",
          }),
        );
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const missingTsx =
          stderr.includes('Command "tsx" not found') ||
          stderr.includes("tsx: command not found") ||
          stderr.includes("tsx: not found");
        reject(
          buildScriptSetupError({
            attemptedCommand: invocation.attemptedCommand,
            message: missingTsx
              ? "`tsx` is not available for the source-checkout CLI package."
              : "The source-checkout local maintainer helper failed.",
            stderr,
          }),
        );
        return;
      }

      const trimmedStdout = stdout.trim();
      if (!trimmedStdout) {
        reject(
          buildScriptSetupError({
            attemptedCommand: invocation.attemptedCommand,
            message:
              "The source-checkout local maintainer helper completed without returning JSON.",
            stderr,
          }),
        );
        return;
      }

      try {
        resolve(parseJsonPayload<T>(trimmedStdout));
      } catch (error) {
        reject(
          buildScriptSetupError({
            attemptedCommand: invocation.attemptedCommand,
            message: `Failed to parse JSON from the source-checkout local maintainer helper: ${
              error instanceof Error ? error.message : String(error)
            }`,
            stderr: [stderr.trim(), trimmedStdout].filter(Boolean).join("\n"),
          }),
        );
      }
    });
  });
}

export async function ensureLocalMaintainerSnapshot(
  apiBaseUrl: string,
): Promise<LocalMaintainerRegistryConfig | null> {
  if (!isLocalMaintainerRegistryEnabled(apiBaseUrl)) {
    return null;
  }
  if (shouldSkipLocalMaintainerHelper()) {
    return readInstalledCliLocalMaintainerSnapshot();
  }

  return runLocalMaintainerScript<LocalMaintainerRegistryConfig | null>([
    "ensure-snapshot",
    "--api-base-url",
    apiBaseUrl,
  ]);
}

export async function readWorkspaceLocalMaintainerRegistry(
  projectRoot: string,
  fallbackRegistryUrl: string = LOCAL_REGISTRY_URL,
): Promise<LocalMaintainerRegistryConfig | null> {
  if (shouldSkipLocalMaintainerHelper()) {
    return null;
  }
  return runLocalMaintainerScript<LocalMaintainerRegistryConfig | null>([
    "read-workspace",
    "--project-root",
    projectRoot,
    "--fallback-registry-url",
    fallbackRegistryUrl,
  ]);
}
