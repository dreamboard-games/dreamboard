import { describe, expect, test } from "bun:test";
import type { LoadedReducerNativeScenario } from "./scenario-loader.js";
import { runLoadedReducerNativeScenarios } from "./scenario-test-runner.js";
import { toTestCommandResult } from "./test-command-result.js";

class FixtureScenarioReplayError extends Error {
  readonly scenarioId = "fixture";
  readonly segment = "when";
  readonly index = 0;
  readonly interactionId = "act";
  readonly errorCode = "NOT_YOUR_TURN";
  readonly reducerMessage = "wrong actor";
  readonly trace = [];
}

class FixtureScenarioDefinitionValidationError extends Error {
  readonly code = "UNKNOWN_INTERACTION";
  readonly path = "scenario.when[0].interactionId";
}

describe("scenario test runner failure boundary", () => {
  test("turns an SDK matcher mismatch into a per-scenario failed result", async () => {
    const assertionError = Object.assign(new Error("Expected 1 to be 2."), {
      name: "ScenarioAssertionError",
      code: "SCENARIO_ASSERTION_FAILED",
    });
    const summary = await runLoadedReducerNativeScenarios([
      fixtureScenario({ assertionError }),
    ]);

    expect(summary).toMatchObject({
      passed: 0,
      failed: 1,
      results: [
        {
          id: "fixture",
          scenarioPath: "test/scenarios/fixture.scenario.ts",
          success: false,
          error: "Expected 1 to be 2.",
          errorCode: "SCENARIO_ASSERTION_FAILED",
        },
      ],
    });
    expect(toTestCommandResult(summary)).toMatchObject({
      ok: false,
      problem: {
        code: "TEST_SCENARIOS_FAILED",
        data: {
          scenarios: [
            {
              status: "failed",
              failure: {
                code: "TEST_ASSERTION_FAILED",
                context: {
                  assertionCode: "SCENARIO_ASSERTION_FAILED",
                },
              },
            },
          ],
        },
      },
    });
  });

  test("retains a recognized replay rejection as a scenario failure", async () => {
    const summary = await runLoadedReducerNativeScenarios([
      fixtureScenario({ replayError: new FixtureScenarioReplayError() }),
    ]);

    expect(summary.results[0]).toMatchObject({
      success: false,
      segment: "when",
      index: 0,
      interactionId: "act",
      errorCode: "NOT_YOUR_TURN",
    });
  });

  test("lets a generic replay exception escape to the semantic family boundary", async () => {
    const unexpected = new Error("replay implementation crashed");

    try {
      await runLoadedReducerNativeScenarios([
        fixtureScenario({ replayError: unexpected }),
      ]);
      throw new Error("Expected the runner to reject.");
    } catch (error) {
      expect(error).toBe(unexpected);
    }
  });

  test("lets a generic authored assertion exception escape to the semantic family boundary", async () => {
    const unexpected = new Error("authored assertion crashed");

    try {
      await runLoadedReducerNativeScenarios([
        fixtureScenario({ assertionError: unexpected }),
      ]);
      throw new Error("Expected the runner to reject.");
    } catch (error) {
      expect(error).toBe(unexpected);
    }
  });
});

function fixtureScenario(options: {
  readonly replayError?: Error;
  readonly assertionError?: Error;
}): LoadedReducerNativeScenario {
  return {
    id: "fixture",
    scenarioPath: "test/scenarios/fixture.scenario.ts",
    sourceDigest: "sha256:fixture",
    sourceInputs: [],
    sdkVersion: "9.8.7-fixture",
    game: {},
    definition: {
      id: "fixture",
      setup: { players: 1, seed: 1 },
      given: [],
      when: [],
      then: () => {},
    },
    replayDefinition: {},
    replayScenario: async () => {
      if (options.replayError) throw options.replayError;
      return { complete: true };
    },
    assertScenario: async () => {
      if (options.assertionError) throw options.assertionError;
    },
    ScenarioReplayError: FixtureScenarioReplayError,
    ScenarioDefinitionValidationError: FixtureScenarioDefinitionValidationError,
  } as LoadedReducerNativeScenario;
}
