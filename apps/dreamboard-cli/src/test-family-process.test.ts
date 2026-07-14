import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ExitCode } from "@dreamboard-games/cli-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  materializeReducerNativeProcessFixture,
  type ReducerNativeProcessFixture,
} from "./test-support/reducer-native-process-fixture.js";

const cliRoot = path.resolve(import.meta.dir, "..");
const cliEntry = path.join(cliRoot, "src", "index.ts");
const bunExecutable = Bun.which("bun") ?? process.execPath;

let fixture: ReducerNativeProcessFixture;

beforeAll(async () => {
  fixture = await materializeReducerNativeProcessFixture();
});

afterAll(async () => {
  await fixture?.cleanup();
});

describe("test-family process boundary", () => {
  test("test, inspect, and explore emit actual success envelopes", () => {
    const testRun = runCli(["test"]);
    const inspectRun = runCli([
      "test",
      "inspect",
      fixture.scenarioPath,
      "--perspective",
      "player:0",
    ]);
    const exploreRun = runCli([
      "test",
      "explore",
      fixture.scenarioPath,
      "--perspective",
      "player:0",
    ]);
    const seedExploreRun = runCli([
      "test",
      "explore",
      fixture.scenarioPath,
      "--perspective",
      "player:0",
      "--at",
      "setup",
      "--seed-range",
      "1:2",
    ]);

    expectSuccessEnvelope(testRun, "test").toMatchObject({
      result: {
        schemaVersion: 1,
        summary: { total: 1, passed: 1, failed: 0 },
        scenarios: [
          {
            id: "fixture.increment",
            path: fixture.scenarioPath,
            status: "passed",
          },
        ],
      },
    });
    expectSuccessEnvelope(inspectRun, "test.inspect").toMatchObject({
      result: {
        schemaVersion: 1,
        scenario: {
          id: "fixture.increment",
          path: fixture.scenarioPath,
          sourceDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        node: {
          checkpoint: { segment: "given", completed: 0 },
          perspective: {
            kind: "player",
            actor: { seat: 0, playerId: "player-1" },
          },
          view: { count: 0, playerId: "player-1" },
          interactions: [{ interactionId: "increment" }],
          actions: [{ interactionId: "increment" }],
        },
      },
    });
    expectSuccessEnvelope(exploreRun, "test.explore").toMatchObject({
      result: {
        schemaVersion: 1,
        mode: "transitions",
        perspective: {
          kind: "player",
          actor: { seat: 0, playerId: "player-1" },
        },
        candidates: [
          { command: { interactionId: "increment", params: { amount: 1 } } },
          { command: { interactionId: "increment", params: { amount: 2 } } },
        ],
        page: { limit: 50, evaluated: 4, truncated: false },
      },
    });
    expectSuccessEnvelope(seedExploreRun, "test.explore").toMatchObject({
      result: {
        schemaVersion: 1,
        mode: "seeds",
        checkpoint: { segment: "setup", completed: 0 },
        variants: [
          { seed: 1, status: "replayed" },
          { seed: 2, status: "replayed" },
        ],
      },
    });
  });

  test("redundant --json is byte-identical for every successful operation", () => {
    const commands = [
      ["test"],
      ["test", "inspect", fixture.scenarioPath, "--perspective", "player:0"],
      ["test", "explore", fixture.scenarioPath, "--perspective", "player:0"],
      [
        "test",
        "explore",
        fixture.scenarioPath,
        "--perspective",
        "player:0",
        "--seed-range",
        "1:2",
      ],
    ] as const;

    for (const command of commands) {
      expect(runCli(command)).toEqual(runCli([...command, "--json"]));
    }
  });

  test("spectator inspect is scoped and spectator explore has no commands", () => {
    const inspectRun = runCli([
      "test",
      "inspect",
      fixture.scenarioPath,
      "--perspective",
      "spectator",
    ]);
    const exploreRun = runCli([
      "test",
      "explore",
      fixture.scenarioPath,
      "--perspective",
      "spectator",
    ]);

    expectSuccessEnvelope(inspectRun, "test.inspect").toMatchObject({
      result: {
        node: {
          perspective: { kind: "spectator" },
          view: { count: 0 },
          interactions: [],
          actions: [],
        },
      },
    });
    expectSuccessEnvelope(exploreRun, "test.explore").toMatchObject({
      result: {
        mode: "transitions",
        perspective: { kind: "spectator" },
        candidates: [],
        page: { evaluated: 0, truncated: false, nextCursor: null },
      },
    });
  });

  test("recognized failures retain stable codes and one clean envelope", () => {
    const cases = [
      {
        args: [
          "test",
          "inspect",
          "test/scenarios/missing.scenario.ts",
          "--perspective",
          "player:0",
        ],
        command: "test.inspect",
        code: "TEST_SCENARIO_NOT_FOUND",
        exitCode: ExitCode.Validation,
      },
      {
        args: [
          "test",
          "inspect",
          fixture.scenarioPath,
          "--perspective",
          "player:1",
        ],
        command: "test.inspect",
        code: "TEST_PERSPECTIVE_INVALID",
        exitCode: ExitCode.Validation,
      },
      {
        args: [
          "test",
          "inspect",
          fixture.scenarioPath,
          "--perspective",
          "player:0",
          "--at",
          "given:1",
        ],
        command: "test.inspect",
        code: "TEST_CHECKPOINT_INVALID",
        exitCode: ExitCode.Validation,
      },
      {
        args: [
          "test",
          "explore",
          fixture.scenarioPath,
          "--perspective",
          "player:0",
          "--limit",
          "201",
        ],
        command: "test.explore",
        code: "TEST_EXPLORE_LIMIT_INVALID",
        exitCode: ExitCode.Validation,
      },
    ] as const;

    for (const expected of cases) {
      expectFailureEnvelope(runCli(expected.args), expected);
    }
  });

  test("loader, replay, aggregate, cursor, and unexpected failures keep their stable process contracts", async () => {
    const duplicateFixture = await materializeReducerNativeProcessFixture();
    try {
      await writeScenario(
        duplicateFixture,
        "duplicate.scenario.ts",
        scenarioSource({ id: "fixture.increment" }),
      );
      expectFailureEnvelope(runCli(["test"], duplicateFixture), {
        command: "test",
        code: "TEST_SCENARIO_DUPLICATE_ID",
        exitCode: ExitCode.Validation,
      });
    } finally {
      await duplicateFixture.cleanup();
    }

    const invalidFixture = await materializeReducerNativeProcessFixture();
    try {
      await overwritePrimaryScenario(
        invalidFixture,
        scenarioSource({ id: "fixture.invalid", players: 0 }),
      );
      expectFailureEnvelope(runCli(["test"], invalidFixture), {
        command: "test",
        code: "TEST_SCENARIO_INVALID",
        exitCode: ExitCode.Validation,
      });
    } finally {
      await invalidFixture.cleanup();
    }

    const rejectedFixture = await materializeReducerNativeProcessFixture();
    try {
      await overwritePrimaryScenario(
        rejectedFixture,
        scenarioSource({
          id: "fixture.rejected",
          given: `[
    {
      actor: { seat: 0 },
      interactionId: "increment",
      params: { amount: 3 },
    },
  ]`,
        }),
      );
      expectFailureEnvelope(
        runCli(
          [
            "test",
            "inspect",
            rejectedFixture.scenarioPath,
            "--perspective",
            "player:0",
          ],
          rejectedFixture,
        ),
        {
          command: "test.inspect",
          code: "TEST_SCENARIO_REPLAY_REJECTED",
          exitCode: ExitCode.Validation,
        },
      );
      const aggregate = runCli(["test"], rejectedFixture);
      expectFailureEnvelope(aggregate, {
        command: "test",
        code: "TEST_SCENARIOS_FAILED",
        exitCode: ExitCode.Validation,
      });
      expect(JSON.parse(aggregate.stdout)).toMatchObject({
        problem: {
          data: {
            summary: { total: 1, passed: 0, failed: 1 },
            scenarios: [
              {
                id: "fixture.rejected",
                status: "failed",
                failure: { code: "TEST_SCENARIO_REPLAY_REJECTED" },
              },
            ],
          },
        },
      });
    } finally {
      await rejectedFixture.cleanup();
    }

    expectFailureEnvelope(
      runCli([
        "test",
        "explore",
        fixture.scenarioPath,
        "--perspective",
        "player:0",
        "--seed-range",
        "1:65",
      ]),
      {
        command: "test.explore",
        code: "TEST_SEED_RANGE_INVALID",
        exitCode: ExitCode.Validation,
      },
    );

    const cursorFixture = await materializeReducerNativeProcessFixture();
    try {
      const firstPage = runCli(
        [
          "test",
          "explore",
          cursorFixture.scenarioPath,
          "--perspective",
          "player:0",
          "--limit",
          "1",
        ],
        cursorFixture,
      );
      const cursor = JSON.parse(firstPage.stdout).result.page.nextCursor;
      expect(typeof cursor).toBe("string");
      const scenarioFile = primaryScenarioFile(cursorFixture);
      const source = await readFile(scenarioFile, "utf8");
      await writeFile(scenarioFile, `${source}\n// cursor authority changed\n`);
      expectFailureEnvelope(
        runCli(
          [
            "test",
            "explore",
            cursorFixture.scenarioPath,
            "--perspective",
            "player:0",
            "--limit",
            "1",
            "--cursor",
            cursor,
          ],
          cursorFixture,
        ),
        {
          command: "test.explore",
          code: "TEST_EXPLORE_CURSOR_STALE",
          exitCode: ExitCode.Conflict,
        },
      );
    } finally {
      await cursorFixture.cleanup();
    }

    for (const variant of ["scenario-loading", "assertion", "replay"] as const) {
      const unexpectedFixture = await materializeReducerNativeProcessFixture();
      try {
        if (variant === "scenario-loading") {
          await overwritePrimaryScenario(
            unexpectedFixture,
            `throw new Error("fixture loading crashed");\n${scenarioSource({ id: "fixture.loading" })}`,
          );
        } else if (variant === "assertion") {
          await overwritePrimaryScenario(
            unexpectedFixture,
            scenarioSource({
              id: "fixture.assertion",
              thenBody: `throw new Error("fixture assertion crashed");`,
            }),
          );
        } else {
          const gameFile = path.join(unexpectedFixture.root, "app", "game.ts");
          const gameSource = await readFile(gameFile, "utf8");
          await writeFile(
            gameFile,
            gameSource.replace(
              "const throwDuringReplay = false;",
              "const throwDuringReplay = true;",
            ),
          );
        }
        const run = runCli(["test"], unexpectedFixture);
        expectFailureEnvelope(run, {
          command: "test",
          code: "TEST_UNEXPECTED",
          exitCode: ExitCode.Unexpected,
        });
        expect(JSON.parse(run.stdout)).toMatchObject({
          problem: { context: { category: expect.any(String) } },
        });
        expect(run.stdout).not.toContain("crashed");
        expect(run.stdout).not.toContain(" at ");
      } finally {
        await unexpectedFixture.cleanup();
      }
    }
  }, 30_000);

  test("json-events emits one unsupported envelope and no progress event", () => {
    const run = runCli([
      "test",
      "explore",
      fixture.scenarioPath,
      "--perspective",
      "player:0",
      "--json-events",
    ]);

    expectFailureEnvelope(run, {
      command: "test.explore",
      code: "TEST_JSON_EVENTS_UNSUPPORTED",
      exitCode: ExitCode.Validation,
    });
    expect(run.stdout).not.toContain('"event":"started"');
  });

  test("test-family help remains human-readable and complete", () => {
    for (const args of [
      ["test", "--help"],
      ["test", "inspect", "--help"],
      ["test", "explore", "--help"],
    ]) {
      const run = runCli(args);
      expect(run.exitCode).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.stdout).toContain(
        "USAGE dreamboard test [OPTIONS] [OPERATION] [PATH]",
      );
      expect(run.stdout).toContain("one JSON envelope by default");
      expect(run.stdout).toContain(
        "setup, given:<completed-count>, or when:<completed-count>",
      );
      expect(run.stdout).toContain("at most 64 seeds");
      expect(run.stdout).toContain("default: 50");
      expect(run.stdout).not.toContain("TEST_UNEXPECTED");
    }
  });
});

type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

function runCli(
  args: readonly string[],
  processFixture: ReducerNativeProcessFixture = fixture,
): ProcessResult {
  const result = Bun.spawnSync({
    cmd: [bunExecutable, cliEntry, ...args],
    cwd: processFixture.root,
    env: {
      ...process.env,
      HOME: processFixture.home,
      DREAMBOARD_CREDENTIAL_BACKEND: "file",
      DREAMBOARD_ENV: "local",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

function primaryScenarioFile(processFixture: ReducerNativeProcessFixture) {
  return path.join(processFixture.root, processFixture.scenarioPath);
}

async function overwritePrimaryScenario(
  processFixture: ReducerNativeProcessFixture,
  source: string,
): Promise<void> {
  await writeFile(primaryScenarioFile(processFixture), source, "utf8");
}

async function writeScenario(
  processFixture: ReducerNativeProcessFixture,
  name: string,
  source: string,
): Promise<void> {
  const scenarioRoot = path.join(processFixture.root, "test", "scenarios");
  await mkdir(scenarioRoot, { recursive: true });
  await writeFile(path.join(scenarioRoot, name), source, "utf8");
}

function scenarioSource(options: {
  readonly id: string;
  readonly players?: number;
  readonly given?: string;
  readonly thenBody?: string;
}): string {
  return `import { defineScenario } from "../testing-types.js";

export default defineScenario({
  id: ${JSON.stringify(options.id)},
  setup: { players: ${options.players ?? 1}, seed: 17 },
  given: ${options.given ?? "[]"},
  when: [],
  then: () => {
    ${options.thenBody ?? ""}
  },
});
`;
}

function expectSuccessEnvelope(
  run: ProcessResult,
  command: "test" | "test.inspect" | "test.explore",
) {
  expectSingleJsonLine(run, ExitCode.Ok);
  const envelope = JSON.parse(run.stdout);
  expect(envelope).toMatchObject({
    schemaVersion: 2,
    ok: true,
    command,
    nextActions: [],
  });
  return expect(envelope);
}

function expectFailureEnvelope(
  run: ProcessResult,
  expected: {
    readonly command: string;
    readonly code: string;
    readonly exitCode: ExitCode;
  },
): void {
  expectSingleJsonLine(run, expected.exitCode);
  expect(JSON.parse(run.stdout)).toMatchObject({
    schemaVersion: 2,
    ok: false,
    command: expected.command,
    problem: { code: expected.code },
    nextActions: [],
    exitCode: expected.exitCode,
  });
}

function expectSingleJsonLine(run: ProcessResult, exitCode: number): void {
  expect(run.exitCode).toBe(exitCode);
  expect(run.stderr).toBe("");
  expect(run.stdout.endsWith("\n")).toBe(true);
  expect(run.stdout.split("\n")).toHaveLength(2);
  expect(() => JSON.parse(run.stdout)).not.toThrow();
  expect(run.stdout).not.toContain("\u001b[");
}
