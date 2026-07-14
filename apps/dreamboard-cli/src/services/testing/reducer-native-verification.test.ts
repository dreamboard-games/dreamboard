import { expect, test } from "bun:test";
import {
  formatReducerNativeScenarioFailure,
  requirePassingReducerNativeScenarios,
  type ReducerNativeScenarioRunner,
} from "./reducer-native-verification.js";

const passingResult = {
  id: "smoke",
  scenarioPath: "test/scenarios/smoke.scenario.ts",
  sourceDigest: "sha256:smoke",
  sdkVersion: "9.8.7-fixture",
  success: true,
} as const;

test("runs the canonical scenario runner exactly once", async () => {
  let calls = 0;
  const runScenarios: ReducerNativeScenarioRunner = async (options) => {
    calls += 1;
    expect(options).toEqual({ projectRoot: "/workspace" });
    return {
      sdkVersion: passingResult.sdkVersion,
      passed: 1,
      failed: 0,
      results: [passingResult],
    };
  };

  await expect(
    requirePassingReducerNativeScenarios(
      {
        projectRoot: "/workspace",
        verificationLabel: "Agent verification",
      },
      { runScenarios },
    ),
  ).resolves.toMatchObject({ passed: 1, failed: 0 });
  expect(calls).toBe(1);
});

test("requires at least one authored scenario", async () => {
  await expect(
    requirePassingReducerNativeScenarios(
      {
        projectRoot: "/workspace",
        verificationLabel: "Exact commit verification",
      },
      {
        runScenarios: async () => ({
          sdkVersion: "9.8.7-fixture",
          passed: 0,
          failed: 0,
          results: [],
        }),
      },
    ),
  ).rejects.toThrow("No scenarios found under test/scenarios/*.scenario.ts");
});

test("preserves scenario path and structured replay location in failures", async () => {
  const failure = {
    id: "opening",
    scenarioPath: "test/scenarios/opening.scenario.ts",
    sourceDigest: "sha256:opening",
    sdkVersion: "9.8.7-fixture",
    success: false,
    error: "command rejected",
    errorCode: "NOT_YOUR_TURN",
    segment: "given" as const,
    index: 2,
    interactionId: "placeWorker",
  };

  expect(formatReducerNativeScenarioFailure(failure)).toBe(
    "FAIL opening (test/scenarios/opening.scenario.ts, given[2], interaction placeWorker, code NOT_YOUR_TURN): command rejected",
  );

  await expect(
    requirePassingReducerNativeScenarios(
      {
        projectRoot: "/workspace",
        verificationLabel: "Exact commit scenario verification",
      },
      {
        runScenarios: async () => ({
          sdkVersion: failure.sdkVersion,
          passed: 0,
          failed: 1,
          results: [failure],
        }),
      },
    ),
  ).rejects.toThrow("given[2]");
});
