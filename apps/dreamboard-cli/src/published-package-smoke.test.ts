import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  materializeReducerNativeProcessFixture,
  type ReducerNativeProcessFixture,
} from "./test-support/reducer-native-process-fixture.js";

const packageRoot = path.resolve(import.meta.dir, "..");
const stageRoot = path.join(packageRoot, ".publish", "package");
const stagedExecutablePath = path.join(stageRoot, "dist", "index.js");

const temporaryHomes: string[] = [];
let reducerFixture: ReducerNativeProcessFixture;

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

function runPublishedCli(
  args: string[],
  env: Record<string, string>,
  cwd = stageRoot,
) {
  const nodeExecutable = Bun.which("node") ?? "node";
  const result = Bun.spawnSync({
    cmd: [nodeExecutable, stagedExecutablePath, ...args],
    cwd,
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

beforeAll(async () => {
  if (process.env.DREAMBOARD_REUSE_STAGED_PACKAGE !== "1") {
    runPackageScript("stage:publish");
  }
  reducerFixture = await materializeReducerNativeProcessFixture();
}, 30_000);

afterAll(async () => {
  await Promise.all([
    ...temporaryHomes.map((home) => rm(home, { recursive: true, force: true })),
    reducerFixture?.cleanup(),
  ]);
});

describe("staged published package", () => {
  test("exports its typed authoring release set", async () => {
    const packageJson = await Bun.file(
      path.join(stageRoot, "package.json"),
    ).json();
    expect(packageJson.exports["./authoring-release-set"]).toEqual({
      types: "./dist/authoring-release-set.d.ts",
      default: "./dist/authoring-release-set.js",
    });
    expect(
      await Bun.file(
        path.join(stageRoot, "dist", "authoring-release-set.d.ts"),
      ).exists(),
    ).toBe(true);

    const releaseSetModule = await import(
      pathToFileURL(path.join(stageRoot, "dist", "authoring-release-set.js"))
        .href
    );
    const releaseSetJson = await Bun.file(
      path.join(stageRoot, "release", "authoring-release-set.json"),
    ).json();

    expect(releaseSetModule.AUTHORING_RELEASE_SET).toEqual(releaseSetJson);
  });

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

  test("published package executes test, inspect, and explore offline", () => {
    const environment = {
      HOME: reducerFixture.home,
      DREAMBOARD_ENV: "local",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    const testRun = runPublishedCli(
      ["test"],
      environment,
      reducerFixture.root,
    );
    const inspectRun = runPublishedCli(
      [
        "test",
        "inspect",
        reducerFixture.scenarioPath,
        "--perspective",
        "player:0",
      ],
      environment,
      reducerFixture.root,
    );
    const exploreRun = runPublishedCli(
      [
        "test",
        "explore",
        reducerFixture.scenarioPath,
        "--perspective",
        "player:0",
      ],
      environment,
      reducerFixture.root,
    );

    expectPublishedSemanticSuccess(testRun, "test").toMatchObject({
      result: { summary: { total: 1, passed: 1, failed: 0 } },
    });
    expectPublishedSemanticSuccess(inspectRun, "test.inspect").toMatchObject({
      result: {
        scenario: { id: "fixture.increment" },
        node: {
          perspective: { kind: "player", actor: { seat: 0 } },
          actions: [{ interactionId: "increment" }],
        },
      },
    });
    expectPublishedSemanticSuccess(exploreRun, "test.explore").toMatchObject({
      result: {
        mode: "transitions",
        candidates: [
          { command: { interactionId: "increment", params: { amount: 1 } } },
          { command: { interactionId: "increment", params: { amount: 2 } } },
        ],
      },
    });
  });
});

function expectPublishedSemanticSuccess(
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  command: "test" | "test.inspect" | "test.explore",
) {
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.split("\n")).toHaveLength(2);
  const envelope = JSON.parse(result.stdout);
  expect(envelope).toMatchObject({
    schemaVersion: 2,
    ok: true,
    command,
    nextActions: [],
  });
  return expect(envelope);
}
