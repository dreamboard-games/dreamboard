import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BootstrapGit, CommitReader } from "../ports/bootstrap-git.js";

const execFileAsync = promisify(execFile);

export type GitRunner = (
  args: readonly string[],
  options?: { cwd?: string },
) => Promise<{ stdout: string; stderr: string }>;

export function createExecFileGitRunner(gitBinary = "git"): GitRunner {
  return async (args, options) =>
    execFileAsync(gitBinary, [...args], {
      cwd: options?.cwd,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
}

export class SystemGit implements BootstrapGit, CommitReader {
  constructor(private readonly runGit: GitRunner = createExecFileGitRunner()) {}

  async init(root: string, initialBranch: "main"): Promise<void> {
    await this.runGit(["init", "--initial-branch", initialBranch], {
      cwd: root,
    });
  }

  async clone(
    url: string,
    destination: string,
    options?: { config?: ReadonlyArray<readonly [string, string]> },
  ): Promise<void> {
    const configArgs = (options?.config ?? []).flatMap(([key, value]) => [
      "-c",
      `${key}=${value}`,
    ]);
    await this.runGit([...configArgs, "clone", url, destination]);
  }

  async setRemote(root: string, name: "origin", url: string): Promise<void> {
    await this.runGit(["remote", "remove", name], { cwd: root }).catch(() => ({
      stdout: "",
      stderr: "",
    }));
    await this.runGit(["remote", "add", name, url], { cwd: root });
  }

  async setLocalConfig(root: string, key: string, value: string): Promise<void> {
    if (key.startsWith("--add ")) {
      await this.runGit(["config", "--local", "--add", key.slice(6), value], {
        cwd: root,
      });
      return;
    }
    await this.runGit(["config", "--local", key, value], { cwd: root });
  }

  async resolveCommit(root: string, revision: string): Promise<string> {
    const result = await this.runGit(
      ["rev-parse", "--verify", `${revision}^{commit}`],
      {
        cwd: root,
      },
    );
    return result.stdout.trim();
  }

  async remoteUrl(root: string, name: "origin"): Promise<string | null> {
    try {
      const result = await this.runGit(["remote", "get-url", name], {
        cwd: root,
      });
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async statusPorcelain(root: string): Promise<string> {
    const result = await this.runGit(
      ["status", "--porcelain", "--untracked-files=no"],
      { cwd: root },
    );
    return result.stdout.trim();
  }

  async createDetachedWorktree(
    root: string,
    commitOid: string,
    destination: string,
  ): Promise<void> {
    await this.runGit(["worktree", "add", "--detach", destination, commitOid], {
      cwd: root,
    });
  }

  async removeWorktree(root: string, destination: string): Promise<void> {
    await this.runGit(["worktree", "remove", "--force", destination], {
      cwd: root,
    });
  }
}
