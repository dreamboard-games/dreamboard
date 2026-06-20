import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SystemGit, type CommitReader } from "@dreamboard-games/cli-core";
import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import type { ResolvedConfig } from "../../types.js";
import { loadProjectConfig } from "../../config/project-config.js";
import { exists } from "../../utils/fs.js";
import { assertCompilerPortableDependencies } from "../project/dependency-portability.js";
import { loadManifest } from "../project/local-files.js";
import { assertReducerContractPreflight } from "../project/reducer-contract-preflight.js";
import { assertReducerBundleSmoke } from "../project/reducer-bundle-preflight.js";
import { runLocalTypecheck } from "../project/local-typecheck.js";
import { applyWorkspaceCodegen } from "../project/workspace-codegen.js";
import {
  generateReducerNativeArtifacts,
  isReducerNativeTestingWorkspace,
  runReducerNativeScenarios,
} from "../testing/reducer-native-test-harness.js";
import type { ProjectConfig } from "../../types.js";
import type { ReducerNativeScenarioSummary } from "../testing/reducer-native-test-harness.js";

export type ExactCommitVerificationResult = {
  projectId: string;
  commitOid: string;
  status: "passed";
  hook: boolean;
  steps: string[];
  scenarioSummary: {
    passed: number;
    failed: number;
    total: number;
  };
};

export type ExactCommitVerifierDeps = {
  git?: CommitReader;
  makeTempDir?: () => Promise<string>;
  readGitTree?: (root: string, commitOid: string) => Promise<GitTreeEntry[]>;
  readPolicyFile?: (root: string, relativePath: string) => Promise<Buffer>;
  runInstall?: (root: string) => Promise<void>;
  loadProjectConfig?: (root: string) => Promise<ProjectConfig>;
  assertPortableDependencies?: (options: {
    projectRoot: string;
    projectConfig?: ProjectConfig;
  }) => Promise<unknown>;
  loadManifest?: (root: string) => Promise<GameTopologyManifest>;
  applyCodegen?: (options: {
    projectRoot: string;
    manifest: GameTopologyManifest;
  }) => Promise<void>;
  assertContract?: (root: string) => Promise<void>;
  runTypecheck?: (root: string) => Promise<{
    skipped: boolean;
    success: boolean;
    output?: string;
  }>;
  assertReducerBundle?: (options: {
    projectRoot: string;
    manifest: GameTopologyManifest;
  }) => Promise<void>;
  isTestingWorkspace?: (root: string) => Promise<boolean>;
  generateArtifacts?: (options: {
    projectRoot: string;
    gameId: string;
    compiledResultId?: string;
  }) => Promise<{ bases: unknown[]; scenarios: unknown[] }>;
  runScenarios?: (options: {
    projectRoot: string;
    projectConfig: ProjectConfig;
    resolvedConfig: ResolvedConfig;
    gameId: string;
    compiledResultId?: string;
  }) => Promise<ReducerNativeScenarioSummary>;
};

export type ExactCommitWorktreeDeps = Pick<
  ExactCommitVerifierDeps,
  "git" | "makeTempDir" | "readGitTree" | "readPolicyFile"
>;

export type ExactCommitWorkspacePreparationDeps = Pick<
  ExactCommitVerifierDeps,
  | "loadProjectConfig"
  | "assertPortableDependencies"
  | "runInstall"
  | "loadManifest"
  | "applyCodegen"
>;

export type GitTreeEntry = {
  mode: string;
  type: string;
  objectId: string;
  path: string;
};

type VerificationStep =
  | "worktree"
  | "source-policy"
  | "dependencies"
  | "codegen"
  | "contract"
  | "typecheck"
  | "reducer-bundle"
  | "scenarios";

const ALLOWED_DREAMBOARD_TRACKED_PATHS = new Set([".dreamboard/project.json"]);
const CREDENTIAL_BASENAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.staging",
  "auth.json",
  "credentials.json",
  "id_rsa",
  "id_dsa",
  "id_ed25519",
]);
const CREDENTIAL_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);
const GENERATED_PATH_PREFIXES = ["test/generated/"];
const LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

export async function runExactCommitVerification(
  options: {
    projectRoot: string;
    config: ResolvedConfig;
    commitOid: string;
    hook: boolean;
  },
  deps: ExactCommitVerifierDeps = {},
): Promise<ExactCommitVerificationResult> {
  const steps: VerificationStep[] = [];

  return withExactCommitWorktree(
    {
      projectRoot: options.projectRoot,
      commitOid: options.commitOid,
      onStep: (step) => steps.push(step),
    },
    async (worktreeRoot) => {
      const { projectConfig, manifest } = await prepareExactCommitWorkspace(
        {
          worktreeRoot,
          onStep: (step) => steps.push(step),
        },
        deps,
      );

      await (deps.assertContract ?? assertReducerContractPreflight)(
        worktreeRoot,
      );
      steps.push("contract");

      const typecheck = await (deps.runTypecheck ?? runLocalTypecheck)(
        worktreeRoot,
      );
      if (typecheck.skipped) {
        throw new Error(
          "Exact commit verification requires installed workspace dependencies before typecheck.",
        );
      }
      if (!typecheck.success) {
        throw new Error(
          ["Exact commit typecheck failed.", typecheck.output?.trim() || null]
            .filter(Boolean)
            .join("\n"),
        );
      }
      steps.push("typecheck");

      await (deps.assertReducerBundle ?? assertReducerBundleSmoke)({
        projectRoot: worktreeRoot,
        manifest,
      });
      steps.push("reducer-bundle");

      if (
        !(await (deps.isTestingWorkspace ?? isReducerNativeTestingWorkspace)(
          worktreeRoot,
        ))
      ) {
        throw new Error(
          "Exact commit verification requires reducer-native bases and scenarios.",
        );
      }
      const runtimeIdentity = {
        gameId: projectConfig.gameId,
        compiledResultId: projectConfig.compile?.latestSuccessful?.resultId,
      };
      const generated = await (
        deps.generateArtifacts ?? generateReducerNativeArtifacts
      )({
        projectRoot: worktreeRoot,
        gameId: runtimeIdentity.gameId,
        compiledResultId: runtimeIdentity.compiledResultId,
      });
      if (generated.bases.length === 0) {
        throw new Error("No bases found under test/bases/*.base.ts.");
      }
      if (generated.scenarios.length === 0) {
        throw new Error(
          "No scenarios found under test/scenarios/*.scenario.ts.",
        );
      }
      const scenarioSummary = await (
        deps.runScenarios ?? runReducerNativeScenarios
      )({
        projectRoot: worktreeRoot,
        projectConfig,
        resolvedConfig: options.config,
        gameId: runtimeIdentity.gameId,
        compiledResultId: runtimeIdentity.compiledResultId,
      });
      steps.push("scenarios");
      if (scenarioSummary.failed > 0) {
        const failures = scenarioSummary.results
          .filter((result) => !result.success)
          .map((result) => `FAIL ${result.id}: ${result.error ?? "failed"}`);
        throw new Error(
          [
            `Exact commit scenario verification failed: ${scenarioSummary.failed} failed, ${scenarioSummary.passed} passed.`,
            ...failures,
          ].join("\n"),
        );
      }

      return {
        projectId: projectConfig.projectId,
        commitOid: options.commitOid,
        status: "passed",
        hook: options.hook,
        steps,
        scenarioSummary: {
          passed: scenarioSummary.passed,
          failed: scenarioSummary.failed,
          total: scenarioSummary.results.length,
        },
      };
    },
    deps,
  );
}

export async function withExactCommitWorktree<T>(
  options: {
    projectRoot: string;
    commitOid: string;
    onStep?: (
      step: Extract<VerificationStep, "worktree" | "source-policy">,
    ) => void;
  },
  run: (worktreeRoot: string) => Promise<T>,
  deps: ExactCommitWorktreeDeps = {},
): Promise<T> {
  const git = deps.git ?? new SystemGit();
  const tempRoot =
    (await deps.makeTempDir?.()) ??
    (await mkdtemp(path.join(os.tmpdir(), "dreamboard-verify-")));
  const worktreeRoot = path.join(tempRoot, "worktree");
  let worktreeCreated = false;

  try {
    await git.createDetachedWorktree(
      options.projectRoot,
      options.commitOid,
      worktreeRoot,
    );
    worktreeCreated = true;
    options.onStep?.("worktree");

    const treeEntries =
      (await deps.readGitTree?.(options.projectRoot, options.commitOid)) ??
      (await readGitTree(options.projectRoot, options.commitOid));
    await assertExactCommitSourcePolicy({
      worktreeRoot,
      entries: treeEntries,
      readFile: deps.readPolicyFile,
    });
    options.onStep?.("source-policy");

    return await run(worktreeRoot);
  } finally {
    if (worktreeCreated) {
      await git
        .removeWorktree(options.projectRoot, worktreeRoot)
        .catch(() => {});
    }
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function prepareExactCommitWorkspace(
  options: {
    worktreeRoot: string;
    onStep?: (
      step: Extract<VerificationStep, "dependencies" | "codegen">,
    ) => void;
  },
  deps: ExactCommitWorkspacePreparationDeps = {},
): Promise<{
  projectConfig: ProjectConfig;
  manifest: GameTopologyManifest;
}> {
  const projectConfig = await (deps.loadProjectConfig ?? loadProjectConfig)(
    options.worktreeRoot,
  );
  await (deps.assertPortableDependencies ?? assertCompilerPortableDependencies)(
    {
      projectRoot: options.worktreeRoot,
      projectConfig,
    },
  );

  await (deps.runInstall ?? runFrozenNoScriptsInstall)(options.worktreeRoot);
  options.onStep?.("dependencies");

  const manifest = await (deps.loadManifest ?? loadManifest)(
    options.worktreeRoot,
  );
  await (deps.applyCodegen ?? applyWorkspaceCodegen)({
    projectRoot: options.worktreeRoot,
    manifest,
  });
  options.onStep?.("codegen");

  return { projectConfig, manifest };
}

export async function assertExactCommitSourcePolicy(options: {
  worktreeRoot: string;
  entries: readonly GitTreeEntry[];
  readFile?: (root: string, relativePath: string) => Promise<Buffer>;
}): Promise<void> {
  const readPolicyFile = options.readFile ?? readPolicyFileFromDisk;
  const violations: string[] = [];

  for (const entry of options.entries) {
    const normalizedPath = normalizeTreePath(entry.path);
    if (!normalizedPath) {
      violations.push(`${entry.path}: path is not normalized`);
      continue;
    }
    if (entry.mode === "160000") {
      violations.push(`${normalizedPath}: gitlinks/submodules are not allowed`);
      continue;
    }
    if (normalizedPath === ".gitmodules") {
      violations.push(".gitmodules is not allowed");
      continue;
    }
    if (normalizedPath === ".lfsconfig") {
      violations.push(".lfsconfig is not allowed");
      continue;
    }
    if (isForbiddenGeneratedPath(normalizedPath)) {
      violations.push(`${normalizedPath}: generated paths must not be tracked`);
      continue;
    }
    if (isForbiddenDreamboardStatePath(normalizedPath)) {
      violations.push(
        `${normalizedPath}: only .dreamboard/project.json may be tracked`,
      );
      continue;
    }
    if (isCredentialLikePath(normalizedPath)) {
      violations.push(
        `${normalizedPath}: credential-like files are not allowed`,
      );
      continue;
    }

    if (entry.type === "blob") {
      const content = await readPolicyFile(
        options.worktreeRoot,
        normalizedPath,
      );
      const textPrefix = content.subarray(0, 4096).toString("utf8");
      if (
        normalizedPath === ".gitattributes" &&
        /filter\s*=\s*lfs/.test(textPrefix)
      ) {
        violations.push(".gitattributes configures Git LFS");
      }
      if (textPrefix.startsWith(LFS_POINTER_PREFIX)) {
        violations.push(
          `${normalizedPath}: Git LFS pointer files are not allowed`,
        );
      }
      if (hasCredentialLikeContent(textPrefix)) {
        violations.push(
          `${normalizedPath}: credential-like content is not allowed`,
        );
      }
    }
  }

  if (violations.length > 0) {
    throw new Error(
      ["Exact commit source policy rejected the commit:", ...violations].join(
        "\n",
      ),
    );
  }
}

async function readGitTree(
  root: string,
  commitOid: string,
): Promise<GitTreeEntry[]> {
  const { stdout } = await runCommand(
    "git",
    ["ls-tree", "-r", "-z", "--full-tree", commitOid],
    root,
  );
  return parseGitTree(stdout);
}

export function parseGitTree(output: string): GitTreeEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) (\S+) ([0-9a-f]+)\t(.+)$/.exec(record);
      if (!match) {
        throw new Error(`Unable to parse git tree entry: ${record}`);
      }
      return {
        mode: match[1]!,
        type: match[2]!,
        objectId: match[3]!,
        path: match[4]!,
      };
    });
}

async function runFrozenNoScriptsInstall(root: string): Promise<void> {
  await runCommand(
    resolvePnpmCommand(),
    [
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--ignore-workspace",
      "--config.shared-workspace-lockfile=false",
    ],
    root,
  );
}

function resolvePnpmCommand(): string {
  const corepackPath = path.join(path.dirname(process.execPath), "corepack");
  return existsSync(corepackPath) ? corepackPath : "pnpm";
}

async function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string }> {
  const finalArgs =
    path.basename(command) === "corepack" ? ["pnpm", ...args] : [...args];
  return new Promise((resolve, reject) => {
    const child = spawn(command, finalArgs, {
      cwd,
      env: { ...process.env, npm_config_ignore_scripts: "true" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(
        new Error(
          [
            `${command} ${finalArgs.join(" ")} failed with exit code ${code}.`,
            stdout.trim() || null,
            stderr.trim() || null,
          ]
            .filter(Boolean)
            .join("\n"),
        ),
      );
    });
  });
}

async function readPolicyFileFromDisk(
  root: string,
  relativePath: string,
): Promise<Buffer> {
  return readFile(path.join(root, relativePath));
}

function normalizeTreePath(filePath: string): string | null {
  if (filePath.includes("\\")) return null;
  const normalized = path.posix.normalize(filePath);
  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isForbiddenGeneratedPath(filePath: string): boolean {
  return GENERATED_PATH_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function isForbiddenDreamboardStatePath(filePath: string): boolean {
  return (
    filePath.startsWith(".dreamboard/") &&
    !ALLOWED_DREAMBOARD_TRACKED_PATHS.has(filePath)
  );
}

function isCredentialLikePath(filePath: string): boolean {
  const basename = path.posix.basename(filePath);
  if (CREDENTIAL_BASENAMES.has(basename)) return true;
  if (CREDENTIAL_EXTENSIONS.has(path.posix.extname(basename))) return true;
  return filePath.startsWith(".dreamboard-dev/deploy-secrets/");
}

function hasCredentialLikeContent(prefix: string): boolean {
  return (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(prefix) ||
    /_authToken\s*=/i.test(prefix) ||
    /(?:^|\n)\s*(?:npm_token|authToken|password|secret)\s*=/i.test(prefix)
  );
}

export async function computeFileDigestIfPresent(
  filePath: string,
): Promise<string | null> {
  if (!(await exists(filePath))) return null;
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex");
}
