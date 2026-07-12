import { describe, expect, test } from "bun:test";
import { ExitCode } from "@dreamboard-games/cli-core";
import { runCommand } from "citty";
import { TestFamilyCommandError } from "../services/testing/test-command-result.js";
import {
  assertNoRemovedTestFlags,
  createTestCommand,
  runTestCommand,
  runTestFamilyCommand,
  type TestCommandDeps,
} from "./test.js";

test("removed test runner flags fail before project resolution", () => {
  expect(() =>
    assertNoRemovedTestFlags(["test", "--runner", "remote"]),
  ).toThrow("dreamboard test no longer supports --runner");
  expect(() => assertNoRemovedTestFlags(["test", "--runner=browser"])).toThrow(
    "dreamboard test no longer supports --runner",
  );
  expect(() => assertNoRemovedTestFlags(["test", "--commit", "HEAD"])).toThrow(
    "dreamboard test no longer supports --commit",
  );
  expect(() => assertNoRemovedTestFlags(["test", "--commit=HEAD"])).toThrow(
    "dreamboard test no longer supports --commit",
  );
  expect(() =>
    assertNoRemovedTestFlags(["test", "--update-snapshots"]),
  ).toThrow("dreamboard test no longer supports --update-snapshots");
  expect(() =>
    assertNoRemovedTestFlags(["test", "--update-snapshots=true"]),
  ).toThrow("dreamboard test no longer supports --update-snapshots");
  expect(() =>
    assertNoRemovedTestFlags(["test", "--scenario", "x"]),
  ).not.toThrow();
});

test("test command returns one semantic scenario result", async () => {
  const calls: string[] = [];
  const result = await runTestCommand(
    { scenario: "test/scenarios/first.scenario.ts" },
    {
      ...projectDeps(calls),
      runScenarios: async (options) => {
        calls.push(`run:${options.projectRoot}:${options.scenarioPath}`);
        return {
          sdkVersion: "0.4.0-test",
          passed: 1,
          failed: 0,
          results: [successfulScenario("first")],
        };
      },
    },
  );

  expect(calls).toEqual([
    "resolve:false",
    "portable:prod:/workspace",
    "workspace:/workspace",
    "run:/workspace:test/scenarios/first.scenario.ts",
  ]);
  expect(result).toEqual({
    schemaVersion: 2,
    ok: true,
    command: "test",
    result: {
      schemaVersion: 1,
      summary: { total: 1, passed: 1, failed: 0 },
      scenarios: [
        {
          id: "first",
          path: "test/scenarios/first.scenario.ts",
          status: "passed",
        },
      ],
    },
    nextActions: [],
  });
});

describe("inspect and explore argument contract", () => {
  test("parses the frozen inspect positional path and selectors through Citty", async () => {
    const requests: unknown[] = [];
    const command = createTestCommand({
      ...projectDeps(),
      inspectScenario: async (request) => {
        requests.push(request);
        return { schemaVersion: 1, node: { checkpointDigest: "sha256:node" } };
      },
    });

    const execution = await runCommand(command, {
      rawArgs: [
        "inspect",
        "test/scenarios/complete-game.scenario.ts",
        "--perspective",
        "player:2",
        "--at",
        "given:3",
        "--seed",
        "17",
      ],
    });

    expect(requests).toEqual([
      {
        projectRoot: "/workspace",
        scenarioPath: "test/scenarios/complete-game.scenario.ts",
        perspective: { kind: "player", seat: 2 },
        checkpoint: { segment: "given", count: 3 },
        seed: 17,
      },
    ]);
    expect(execution.result).toMatchObject({
      ok: true,
      command: "test.inspect",
      result: { schemaVersion: 1 },
    });
  });

  test("passes deterministic explore defaults and a bounded seed range", async () => {
    const requests: unknown[] = [];
    const result = await runTestFamilyCommand(
      {
        operation: "explore",
        path: "test/scenarios/complete-game.scenario.ts",
        perspective: "spectator",
        at: "setup",
        "seed-range": "-2:3",
      },
      {
        ...projectDeps(),
        exploreScenario: async (request) => {
          requests.push(request);
          return { schemaVersion: 1, mode: "seeds", variants: [] };
        },
      },
    );

    expect(requests).toEqual([
      {
        projectRoot: "/workspace",
        scenarioPath: "test/scenarios/complete-game.scenario.ts",
        perspective: { kind: "spectator" },
        checkpoint: { segment: "setup" },
        seed: undefined,
        seedRange: { start: -2, end: 3 },
        limit: 50,
        maxEvaluations: 5_000,
        cursor: undefined,
      },
    ]);
    expect(result).toMatchObject({ ok: true, command: "test.explore" });
  });

  test("rejects malformed perspective, checkpoint, range, and limits stably", async () => {
    const cases = [
      {
        args: { perspective: "player:x" },
        code: "TEST_PERSPECTIVE_INVALID",
      },
      {
        args: { perspective: "player:0", at: "given:-1" },
        code: "TEST_CHECKPOINT_INVALID",
      },
      {
        args: { perspective: "player:0", "seed-range": "1:65" },
        code: "TEST_SEED_RANGE_INVALID",
      },
      {
        args: { perspective: "player:0", limit: "201" },
        code: "TEST_EXPLORE_LIMIT_INVALID",
      },
    ] as const;

    for (const entry of cases) {
      try {
        await runTestFamilyCommand(
          {
            operation: "explore",
            path: "test/scenarios/example.scenario.ts",
            ...entry.args,
          },
          {
            ...projectDeps(),
            exploreScenario: async () => ({ schemaVersion: 1 }),
          },
        );
        throw new Error("Expected validation to fail.");
      } catch (error) {
        expect(error).toBeInstanceOf(TestFamilyCommandError);
        expect((error as TestFamilyCommandError).problem.code).toBe(entry.code);
        expect((error as TestFamilyCommandError).exitCode).toBe(
          ExitCode.Validation,
        );
      }
    }
  });
});

function projectDeps(calls: string[] = []): TestCommandDeps {
  return {
    resolveProjectContext: async (_flags, options) => {
      calls.push(`resolve:${options?.requireAuth}`);
      return {
        projectRoot: "/workspace",
        projectConfig: {
          schemaVersion: 2,
          projectId: "project-1",
          slug: "project-1",
          compile: {
            latestSuccessful: {
              resultId: "compiled-local",
              revisionDigest: "revision-digest-1",
            },
          },
        },
        config: {
          environment: "prod",
          apiBaseUrl: "https://api.example.com",
          webBaseUrl: "https://web.example.com",
          authTokenSource: "none",
          refreshTokenSource: "none",
        },
      } as any;
    },
    assertPortableDependencies: async (options) => {
      calls.push(`portable:${options.environment}:${options.projectRoot}`);
    },
    assertTestingWorkspace: async (projectRoot) => {
      calls.push(`workspace:${projectRoot}`);
    },
  };
}

function successfulScenario(id: string) {
  return {
    id,
    scenarioPath: `test/scenarios/${id}.scenario.ts`,
    sourceDigest: `sha256:${id}`,
    sdkVersion: "0.4.0-test",
    success: true,
  } as const;
}
