import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SystemGit, type CommitReader } from "@dreamboard-games/cli-core";
import { defineCommand } from "citty";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import {
  parseCommitScopedCommandArgs,
  type ConfigFlags,
} from "../flags.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { resolveConfig } from "../config/resolve.js";
import type { GlobalConfig, ResolvedConfig } from "../types.js";
import { printJsonOrSummary } from "./commit-scoped.js";
import {
  runExactCommitVerification,
  type ExactCommitVerificationResult,
} from "../services/verification/exact-commit-verifier.js";

const execFileAsync = promisify(execFile);

type VerifyCommandArgs = ConfigFlags & {
  commit: string;
  hook?: boolean;
  json?: boolean;
};

type VerifyCommandDeps = {
  findGitRoot?: () => Promise<string>;
  git?: Pick<CommitReader, "resolveCommit">;
  loadGlobalConfig?: () => Promise<GlobalConfig>;
  resolveConfig?: (
    globalConfig: GlobalConfig,
    flags: ConfigFlags,
  ) => ResolvedConfig;
  verify?: (options: {
    projectRoot: string;
    config: ResolvedConfig;
    commitOid: string;
    hook: boolean;
  }) => Promise<ExactCommitVerificationResult>;
};

async function findGitRoot(): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["rev-parse", "--show-toplevel"],
    {
      cwd: process.cwd(),
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    },
  );
  return stdout.trim();
}

export async function runVerifyCommand(
  args: VerifyCommandArgs,
  deps: VerifyCommandDeps = {},
): Promise<ExactCommitVerificationResult> {
  const projectRoot = await (deps.findGitRoot ?? findGitRoot)();
  const git = deps.git ?? new SystemGit();
  const [globalConfig, commitOid] = await Promise.all([
    (deps.loadGlobalConfig ?? loadGlobalConfig)(),
    git.resolveCommit(projectRoot, args.commit),
  ]);
  const resolvedConfig = (deps.resolveConfig ?? ((global, flags) =>
    resolveConfig(global, flags, undefined, undefined)))(globalConfig, args);
  return (deps.verify ?? runExactCommitVerification)({
    projectRoot,
    config: resolvedConfig,
    commitOid,
    hook: Boolean(args.hook),
  });
}

export default defineCommand({
  meta: {
    name: "verify",
    description: "Verify an exact Git commit",
  },
  args: {
    commit: {
      type: "string",
      description: "Git revision to resolve once before verifying",
      required: true,
    },
    hook: {
      type: "boolean",
      description: "Run in advisory Git hook mode",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Print machine-readable verification JSON",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseCommitScopedCommandArgs("verify", args);
    const result = await runVerifyCommand(parsedArgs);
    printJsonOrSummary({
      json: Boolean(parsedArgs.json),
      value: result,
      summary: `Verified exact commit ${result.commitOid}: ${result.scenarioSummary.passed} scenario(s) passed.`,
    });
  },
});
