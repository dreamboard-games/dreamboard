import { describe, expect, test } from "bun:test";
import { ExitCode } from "@dreamboard-games/cli-core";
import path from "node:path";

const cliRoot = path.resolve(import.meta.dir, "..");
const bunExecutable = Bun.which("bun") ?? process.execPath;

describe("test-family process boundary", () => {
  test("default output and redundant --json are the same single envelope", () => {
    const defaultRun = runCli(["test", "inspect"]);
    const redundantJsonRun = runCli(["test", "inspect", "--json"]);

    expect(defaultRun).toEqual(redundantJsonRun);
    expectProcessEnvelope(defaultRun, {
      command: "test.inspect",
      code: "TEST_SCENARIO_NOT_FOUND",
      exitCode: ExitCode.Validation,
    });
  });

  test("json-events emits one unsupported envelope and no progress event", () => {
    const run = runCli(["test", "explore", "--json-events"]);

    expectProcessEnvelope(run, {
      command: "test.explore",
      code: "TEST_JSON_EVENTS_UNSUPPORTED",
      exitCode: ExitCode.Validation,
    });
    expect(run.stdout).not.toContain('"event":"started"');
  });

  test("recognized-family validation never leaks usage or a stack to stderr", () => {
    const run = runCli([
      "test",
      "inspect",
      "test/scenarios/example.scenario.ts",
      "--perspective",
      "player:not-a-seat",
    ]);

    expectProcessEnvelope(run, {
      command: "test.inspect",
      code: "TEST_PERSPECTIVE_INVALID",
      exitCode: ExitCode.Validation,
    });
    expect(run.stdout).not.toContain("USAGE");
    expect(run.stdout).not.toContain(" at ");
  });
});

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(args: readonly string[]): ProcessResult {
  const result = Bun.spawnSync({
    cmd: [bunExecutable, "src/index.ts", ...args],
    cwd: cliRoot,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

function expectProcessEnvelope(
  run: ProcessResult,
  expected: {
    readonly command: string;
    readonly code: string;
    readonly exitCode: ExitCode;
  },
): void {
  expect(run.exitCode).toBe(expected.exitCode);
  expect(run.stderr).toBe("");
  expect(run.stdout.endsWith("\n")).toBe(true);
  expect(run.stdout.split("\n")).toHaveLength(2);
  expect(JSON.parse(run.stdout)).toMatchObject({
    schemaVersion: 2,
    ok: false,
    command: expected.command,
    problem: { code: expected.code },
    nextActions: [],
    exitCode: expected.exitCode,
  });
}
