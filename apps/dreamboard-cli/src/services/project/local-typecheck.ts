import { MANIFEST_TYPECHECK_CONFIG_FILE } from "../../constants.js";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

export type LocalTypecheckResult = {
  success: boolean;
  output: string;
  skipped?: boolean;
};

type TypecheckRunner = {
  command: string;
  argsPrefix: string[];
};

const TYPESCRIPT_BIN_PATH_SEGMENTS = [
  "node_modules",
  "typescript",
  "bin",
  "tsc",
];

// TypeScript shipped with the CLI package itself; used as a fallback when the
// user's workspace does not provide its own `typescript` install.
const CLI_PACKAGE_TYPESCRIPT_CLI = resolveCliPackageTypescriptCli();

function resolveCliPackageTypescriptCli(): string | null {
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("typescript/bin/tsc");
  } catch {
    return null;
  }
}

function getProjectNodeModules(projectRoot: string): string {
  return path.join(projectRoot, "node_modules");
}

function getProjectTypescriptCli(projectRoot: string): string {
  return path.join(projectRoot, ...TYPESCRIPT_BIN_PATH_SEGMENTS);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureTypecheckDependencies(
  projectRoot: string,
): Promise<string | null> {
  if (await pathExists(getProjectNodeModules(projectRoot))) {
    return null;
  }

  return `Skipping local typecheck: workspace dependencies are not installed at ${getProjectNodeModules(projectRoot)}. Run \`pnpm install --frozen-lockfile\` or recreate the workspace with \`dreamboard project create\` / \`dreamboard project clone\` first.`;
}

async function resolveTypecheckRunner(
  projectRoot: string,
): Promise<TypecheckRunner | null> {
  const localTypescriptCli = getProjectTypescriptCli(projectRoot);
  if (await pathExists(localTypescriptCli)) {
    return {
      command: process.execPath,
      argsPrefix: [localTypescriptCli],
    };
  }

  if (
    CLI_PACKAGE_TYPESCRIPT_CLI &&
    (await pathExists(CLI_PACKAGE_TYPESCRIPT_CLI))
  ) {
    return {
      command: process.execPath,
      argsPrefix: [CLI_PACKAGE_TYPESCRIPT_CLI],
    };
  }

  const globalTscAvailable = await new Promise<boolean>((resolve) => {
    const child = spawn("tsc", ["--version"], {
      env: process.env,
      stdio: "ignore",
    });

    child.on("error", () => {
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });

  if (!globalTscAvailable) {
    return null;
  }

  return {
    command: "tsc",
    argsPrefix: [],
  };
}

async function runTypecheckProject(
  runner: TypecheckRunner,
  projectRoot: string,
  projectPath: string,
): Promise<LocalTypecheckResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      runner.command,
      [...runner.argsPrefix, "--noEmit", "-p", projectPath],
      {
        cwd: projectRoot,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(new Error(`Failed to start local typecheck. ${error.message}`));
    });
    child.on("close", (code) => {
      const output = [stdout, stderr].filter(Boolean).join("\n").trim();
      resolve({
        success: code === 0,
        output,
      });
    });
  });
}

export async function runLocalTypecheck(
  projectRoot: string,
): Promise<LocalTypecheckResult> {
  const dependencySkipReason = await ensureTypecheckDependencies(projectRoot);
  if (dependencySkipReason) {
    return {
      success: true,
      skipped: true,
      output: dependencySkipReason,
    };
  }

  const runner = await resolveTypecheckRunner(projectRoot);
  if (!runner) {
    return {
      success: true,
      skipped: true,
      output:
        "Skipping local typecheck: TypeScript CLI was not found in workspace dependencies or on PATH.",
    };
  }

  // The three projects are independent (no cross-project references), so
  // checking them in parallel roughly halves wall-clock time without changing
  // correctness. The slowest project (typically `ui/tsconfig.json`) bounds the
  // total cost.
  const results = await Promise.all(
    [
      MANIFEST_TYPECHECK_CONFIG_FILE,
      "app/tsconfig.json",
      "ui/tsconfig.json",
    ].map((projectPath) =>
      runTypecheckProject(runner, projectRoot, projectPath),
    ),
  );

  const firstFailure = results.find((result) => !result.success);
  if (firstFailure) {
    return firstFailure;
  }

  return {
    success: true,
    output: "",
  };
}
