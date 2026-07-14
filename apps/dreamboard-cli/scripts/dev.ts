import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const rawArgs = process.argv.slice(2);
const packageRoot = process.cwd();
const isProd = rawArgs.includes("--prod");
const args = rawArgs.filter((arg) => arg !== "--prod");

const invokedCwd = process.env.INIT_CWD || process.env.PWD || process.cwd();

const projectCommands = new Set(["run", "pull", "push", "status", "scaffold"]);
let spawnCwd = invokedCwd;

if (projectCommands.has(args[0] ?? "")) {
  if (!hasProjectConfig(invokedCwd)) {
    const candidates = findProjectCandidates(invokedCwd);
    if (candidates.length === 1) {
      spawnCwd = candidates[0]!;
    } else if (candidates.length > 1) {
      // eslint-disable-next-line no-console
      console.error(
        `Multiple Dreamboard projects found under ${invokedCwd}. Run from the desired project folder.`,
      );
      process.exit(1);
    }
  }
}

if (process.env.DREAMBOARD_DEV_DEBUG === "1") {
  // Debugging helper to understand bun cwd behavior
  // eslint-disable-next-line no-console
  console.log("[dreamboard-cli dev] cwd:", process.cwd());
  // eslint-disable-next-line no-console
  console.log("[dreamboard-cli dev] PWD:", process.env.PWD);
  // eslint-disable-next-line no-console
  console.log("[dreamboard-cli dev] INIT_CWD:", process.env.INIT_CWD);
  // eslint-disable-next-line no-console
  console.log("[dreamboard-cli dev] invokedCwd:", invokedCwd);
  // eslint-disable-next-line no-console
  console.log("[dreamboard-cli dev] spawnCwd:", spawnCwd);
}

const env = { ...process.env };
if (isProd) {
  env.DREAMBOARD_API_BASE_URL ??= "https://api.dreamboard.games";
  env.DREAMBOARD_WEB_BASE_URL ??= "https://dreamboard.games";
} else {
  const environment = explicitEnvironment(args) ?? "local";
  const defaults = environmentDefaults(environment);
  env.DREAMBOARD_API_BASE_URL ??= defaults.apiBaseUrl;
  env.DREAMBOARD_WEB_BASE_URL ??= defaults.webBaseUrl;
}

const bunPath = process.execPath;
const scriptPath = path.join(packageRoot, "src", "index.ts");
const child = spawn(bunPath, ["run", scriptPath, ...args], {
  stdio: "inherit",
  env,
  cwd: spawnCwd,
});

child.on("exit", (code) => {
  process.exit(code ?? 0);
});

function hasProjectConfig(dir: string): boolean {
  return existsSync(path.join(dir, ".dreamboard", "project.json"));
}

function findProjectCandidates(dir: string): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const candidate = path.join(dir, entry);
      try {
        if (statSync(candidate).isDirectory() && hasProjectConfig(candidate)) {
          results.push(candidate);
        }
      } catch {
        // ignore unreadable entries
      }
    }
  } catch {
    return [];
  }
  return results;
}

function explicitEnvironment(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--env") {
      return normalizeEnvironment(args[index + 1]);
    }
    if (arg?.startsWith("--env=")) {
      return normalizeEnvironment(arg.slice("--env=".length));
    }
  }
  return null;
}

function normalizeEnvironment(value: string | undefined): string | null {
  return value === "local" || value === "staging" || value === "prod"
    ? value
    : null;
}

function environmentDefaults(environment: string): {
  apiBaseUrl: string;
  webBaseUrl: string;
} {
  if (environment === "staging") {
    return {
      apiBaseUrl: "https://api-staging.dreamboard.games",
      webBaseUrl: "https://staging.dreamboard.games",
    };
  }
  if (environment === "prod") {
    return {
      apiBaseUrl: "https://api.dreamboard.games",
      webBaseUrl: "https://dreamboard.games",
    };
  }
  return {
    apiBaseUrl: "http://localhost:8080",
    webBaseUrl: "http://localhost:5173",
  };
}
