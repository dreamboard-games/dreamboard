import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const stageRoot = path.join(packageRoot, ".publish", "package");
const stagedExecutablePath = path.join(stageRoot, "dist", "index.js");

const temporaryHomes: string[] = [];

function runPackageScript(scriptName: string): void {
  const pnpmExecutable = Bun.which("pnpm") ?? "pnpm";
  const result = Bun.spawnSync({
    cmd: [pnpmExecutable, "run", scriptName],
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `pnpm run ${scriptName} failed with exit code ${result.exitCode}`,
        result.stdout.toString(),
        result.stderr.toString(),
      ].join("\n"),
    );
  }
}

function runPublishedCli(args: string[], env: Record<string, string>) {
  const nodeExecutable = Bun.which("node") ?? "node";
  const result = Bun.spawnSync({
    cmd: [nodeExecutable, stagedExecutablePath, ...args],
    cwd: stageRoot,
    env: {
      ...process.env,
      DREAMBOARD_CREDENTIAL_BACKEND: "file",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

beforeAll(() => {
  runPackageScript("stage:publish");
});

afterAll(async () => {
  await Promise.all(
    temporaryHomes.map((home) => rm(home, { recursive: true, force: true })),
  );
});

describe("staged published package", () => {
  test("exposes the Phase 8 public command tree", () => {
    const mainHelp = runPublishedCli(["--help"], {});
    const authHelp = runPublishedCli(["auth", "--help"], {});
    const projectHelp = runPublishedCli(["project", "--help"], {});
    const releaseHelp = runPublishedCli(["release", "--help"], {});
    const hiddenGitCredentialHelp = runPublishedCli(
      ["auth", "git-credential", "--help"],
      {},
    );
    const removedRepositoryCommand = runPublishedCli(
      ["project", "repository", "get", "project-id"],
      {},
    );

    expect(mainHelp.exitCode).toBe(0);
    expect(mainHelp.stdout).toContain(
      "USAGE dreamboard auth|project|verify|test|dev|build|preview|release|doctor",
    );
    expect(authHelp.exitCode).toBe(0);
    expect(authHelp.stdout).toContain(
      "USAGE dreamboard auth login|logout|status",
    );
    expect(projectHelp.exitCode).toBe(0);
    expect(projectHelp.stdout).toContain(
      "USAGE dreamboard project create|clone|status",
    );
    expect(releaseHelp.exitCode).toBe(0);
    expect(releaseHelp.stdout).toContain(
      "USAGE dreamboard release publish|current",
    );
    expect(hiddenGitCredentialHelp.exitCode).toBe(0);
    expect(hiddenGitCredentialHelp.stdout).toContain(
      "USAGE auth git-credential",
    );
    expect(removedRepositoryCommand.exitCode).toBe(1);
    expect(removedRepositoryCommand.stderr).toContain(
      "Unknown command repository",
    );
    expect(removedRepositoryCommand.stdout).toContain(
      "USAGE dreamboard project create|clone|status",
    );
  });

  test("published auth status is executable", async () => {
    const temporaryHome = await mkdtemp(
      path.join(os.tmpdir(), "dreamboard-published-auth-"),
    );
    temporaryHomes.push(temporaryHome);

    const result = runPublishedCli(["auth", "status", "--json"], {
      HOME: temporaryHome,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain(
      "only supports browser login and logout",
    );
  });

  test("published alpha package accepts environment selection", async () => {
    const temporaryHome = await mkdtemp(
      path.join(os.tmpdir(), "dreamboard-published-alpha-env-"),
    );
    temporaryHomes.push(temporaryHome);

    const help = runPublishedCli(["auth", "login", "--help"], {
      HOME: temporaryHome,
    });
    const result = runPublishedCli(["auth", "status", "--env", "staging"], {
      HOME: temporaryHome,
    });

    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--env=<env>");
    expect(result.exitCode).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(
      "production-only",
    );
  });
});
