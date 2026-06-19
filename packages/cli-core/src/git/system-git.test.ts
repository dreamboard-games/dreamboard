import { describe, expect, test } from "bun:test";
import { SystemGit, type GitRunner } from "./system-git.js";

describe("SystemGit", () => {
  test("exposes only bootstrap and commit-reader operations", async () => {
    const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
    const runner: GitRunner = async (args, options) => {
      calls.push({ args, cwd: options?.cwd });
      if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
      if (args[0] === "remote" && args[1] === "get-url") {
        return { stdout: "https://git.example/repos/id.git\n", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    };
    const git = new SystemGit(runner);

    await git.init("/project", "main");
    await git.clone("https://git.example/repos/id.git", "/tmp/clone");
    await git.setRemote("/project", "origin", "https://git.example/repos/id.git");
    await git.setLocalConfig("/project", "credential.useHttpPath", "true");
    await expect(git.resolveCommit("/project", "HEAD")).resolves.toBe("abc123");
    await expect(git.remoteUrl("/project", "origin")).resolves.toBe(
      "https://git.example/repos/id.git",
    );
    await git.createDetachedWorktree("/project", "abc123", "/tmp/worktree");
    await git.removeWorktree("/project", "/tmp/worktree");

    expect(calls.map((call) => call.args)).toEqual([
      ["init", "--initial-branch", "main"],
      ["clone", "https://git.example/repos/id.git", "/tmp/clone"],
      ["remote", "remove", "origin"],
      ["remote", "add", "origin", "https://git.example/repos/id.git"],
      ["config", "--local", "credential.useHttpPath", "true"],
      ["rev-parse", "--verify", "HEAD^{commit}"],
      ["remote", "get-url", "origin"],
      ["worktree", "add", "--detach", "/tmp/worktree", "abc123"],
      ["worktree", "remove", "--force", "/tmp/worktree"],
    ]);
    expect("push" in git).toBe(false);
    expect("merge" in git).toBe(false);
  });
});
