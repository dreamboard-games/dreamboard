import { describe, expect, test } from "bun:test";
import { ExitCode } from "@dreamboard-games/cli-core";
import {
  TestFamilyCommandError,
  classifyTestFamilyFailure,
  toTestCommandResult,
  toTestRunResult,
} from "./test-command-result.js";
import type { ReducerNativeScenarioSummary } from "./scenario-test-runner.js";

describe("test command results", () => {
  test("orders successful scenarios by normalized path and ID", () => {
    const result = toTestRunResult(
      summary([
        successfulScenario("zeta", "test/scenarios/z.scenario.ts"),
        successfulScenario("beta", "test/scenarios/a.scenario.ts"),
        successfulScenario("alpha", "test/scenarios/a.scenario.ts"),
      ]),
    );

    expect(result).toEqual({
      schemaVersion: 1,
      summary: { total: 3, passed: 3, failed: 0 },
      scenarios: [
        {
          id: "alpha",
          path: "test/scenarios/a.scenario.ts",
          status: "passed",
        },
        {
          id: "beta",
          path: "test/scenarios/a.scenario.ts",
          status: "passed",
        },
        {
          id: "zeta",
          path: "test/scenarios/z.scenario.ts",
          status: "passed",
        },
      ],
    });
  });

  test("retains structured replay, validation, and assertion failures", () => {
    const result = toTestRunResult(
      summary([
        {
          ...successfulScenario("replay", "test/scenarios/replay.scenario.ts"),
          success: false,
          error: "Reducer rejected command",
          errorCode: "NOT_YOUR_TURN",
          segment: "given",
          index: 2,
          interactionId: "placeWorker",
        },
        {
          ...successfulScenario(
            "invalid",
            "test/scenarios/invalid.scenario.ts",
          ),
          success: false,
          error: "Invalid actor",
          errorCode: "INVALID_PLAYER_REF",
          validationPath: "scenario.when[0].actor.seat",
        },
        {
          ...successfulScenario(
            "assertion",
            "test/scenarios/assert.scenario.ts",
          ),
          success: false,
          error: "Expected score 10, received 9",
        },
      ]),
    );

    expect(result.scenarios).toEqual([
      {
        id: "assertion",
        path: "test/scenarios/assert.scenario.ts",
        status: "failed",
        failure: {
          code: "TEST_ASSERTION_FAILED",
          message: "Expected score 10, received 9",
          context: {},
        },
      },
      {
        id: "invalid",
        path: "test/scenarios/invalid.scenario.ts",
        status: "failed",
        failure: {
          code: "TEST_SCENARIO_INVALID",
          message: "Invalid actor",
          context: {
            fieldPath: "scenario.when[0].actor.seat",
            validationCode: "INVALID_PLAYER_REF",
          },
        },
      },
      {
        id: "replay",
        path: "test/scenarios/replay.scenario.ts",
        status: "failed",
        failure: {
          code: "TEST_SCENARIO_REPLAY_REJECTED",
          message: "Reducer rejected command",
          context: {
            segment: "given",
            sourceIndex: 2,
            interactionId: "placeWorker",
            errorCode: "NOT_YOUR_TURN",
          },
        },
      },
    ]);
  });

  test("returns the complete deterministic summary in failure problem data", () => {
    const commandResult = toTestCommandResult(
      summary([
        {
          ...successfulScenario("failed", "test/scenarios/failed.scenario.ts"),
          success: false,
          error: "Expected game over",
        },
      ]),
    );

    expect(commandResult).toMatchObject({
      schemaVersion: 2,
      ok: false,
      command: "test",
      exitCode: ExitCode.Validation,
      problem: {
        code: "TEST_SCENARIOS_FAILED",
        context: { total: 1, failed: 1 },
        data: {
          schemaVersion: 1,
          summary: { total: 1, passed: 0, failed: 1 },
        },
      },
    });
  });

  test("maps loader failures without parsing their messages", () => {
    expect(
      classifyTestFamilyFailure(
        {
          name: "ScenarioLoaderError",
          code: "INVALID_SCENARIO_SELECTOR",
          selectorReason: "notFound",
          scenarioPath: "test/scenarios/missing.scenario.ts",
          message: "wording may change",
        },
        "test",
      ),
    ).toEqual({
      problem: {
        title: "The requested scenario was not found",
        code: "TEST_SCENARIO_NOT_FOUND",
        context: {
          requestedPath: "test/scenarios/missing.scenario.ts",
        },
      },
      exitCode: ExitCode.Validation,
    });

    expect(
      classifyTestFamilyFailure(
        {
          name: "ScenarioLoaderError",
          code: "DUPLICATE_SCENARIO_ID",
          scenarioId: "duplicate",
          scenarioPaths: [
            "test/scenarios/a.scenario.ts",
            "test/scenarios/b.scenario.ts",
          ],
          message: "wording may change",
        },
        "test",
      ),
    ).toMatchObject({
      problem: {
        code: "TEST_SCENARIO_DUPLICATE_ID",
        context: {
          scenarioId: "duplicate",
          firstPath: "test/scenarios/a.scenario.ts",
          secondPath: "test/scenarios/b.scenario.ts",
        },
      },
      exitCode: ExitCode.Validation,
    });
  });

  test("redacts unexpected execution details behind a stable category", () => {
    const failure = classifyTestFamilyFailure(
      new Error("secret path /tmp/workspace and stack content"),
      "test.inspect",
    );

    expect(failure).toEqual({
      problem: {
        title: "The test command failed unexpectedly",
        detail:
          "The command did not complete. Retry it, then report the stable category if it repeats.",
        code: "TEST_UNEXPECTED",
        context: { category: "execution" },
      },
      exitCode: ExitCode.Unexpected,
    });
    expect(JSON.stringify(failure)).not.toContain("/tmp/workspace");
  });

  test("preserves explicit typed test-family failures", () => {
    const error = new TestFamilyCommandError({
      command: "test.inspect",
      problem: {
        title: "Invalid perspective",
        code: "TEST_PERSPECTIVE_INVALID",
        context: { requestedPerspective: "player:x" },
      },
    });

    expect(classifyTestFamilyFailure(error, "test.inspect")).toEqual({
      problem: error.problem,
      exitCode: ExitCode.Validation,
    });
  });
});

function summary(
  results: ReducerNativeScenarioSummary["results"],
): ReducerNativeScenarioSummary {
  const passed = results.filter((result) => result.success).length;
  return {
    sdkVersion: "0.4.0-test",
    passed,
    failed: results.length - passed,
    results,
  };
}

function successfulScenario(id: string, scenarioPath: string) {
  return {
    id,
    scenarioPath,
    sourceDigest: `sha256:${id}`,
    sdkVersion: "0.4.0-test",
    success: true,
  } as const;
}
