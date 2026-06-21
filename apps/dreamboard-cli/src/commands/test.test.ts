import { expect, test } from "bun:test";
import {
  assertNoRemovedTestFlags,
  runTestCommand,
  resolveTestCommandPlan,
  resolveTestRunExitCode,
} from "./test.js";
import {
  STALE_CONTRACT_ARTIFACT_CODE,
  STALE_CONTRACT_ARTIFACT_EXIT_CODE,
} from "../utils/errors.js";

test("test command plan is reducer-only", () => {
  expect(resolveTestCommandPlan({})).toEqual({
    updateSnapshots: false,
  });
  expect(resolveTestCommandPlan({ "update-snapshots": true })).toEqual({
    updateSnapshots: true,
  });
});

test("removed test runner flags fail before project resolution", () => {
  expect(() => assertNoRemovedTestFlags(["test", "--runner", "remote"])).toThrow(
    "dreamboard test no longer supports --runner",
  );
  expect(() => assertNoRemovedTestFlags(["test", "--runner=browser"])).toThrow(
    "dreamboard test no longer supports --runner",
  );
  expect(() => assertNoRemovedTestFlags(["test", "--commit", "HEAD"])).toThrow(
    "dreamboard test no longer supports --commit",
  );
  expect(() => assertNoRemovedTestFlags(["test", "--commit=HEAD"])).toThrow(
    "dreamboard test no longer supports --commit",
  );
  expect(() => assertNoRemovedTestFlags(["test", "--scenario", "x"])).not.toThrow();
});

test("stale contract artifact failures use the dedicated exit code", () => {
  const exitCode = resolveTestRunExitCode({
    passed: 0,
    failed: 1,
    results: [
      {
        id: "scenario-1",
        success: false,
        errorCode: STALE_CONTRACT_ARTIFACT_CODE,
      },
    ],
  } as any);

  expect(exitCode).toBe(STALE_CONTRACT_ARTIFACT_EXIT_CODE);
});

test("test command runs reducer scenarios against the current workspace", async () => {
  const calls: string[] = [];
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    await runTestCommand(
      {
        scenario: "test/scenarios/first.scenario.ts",
        debug: true,
        "update-snapshots": true,
      },
      {
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
        generateArtifacts: async (options) => {
          calls.push(
            `generate:${options.projectRoot}:${options.compiledResultId}:${options.projectId}:${options.scenarioPath}:${options.debug}`,
          );
          return {
            bases: [{}],
            scenarios: [{}],
          } as any;
        },
        runScenarios: async (options) => {
          calls.push(
            `run:${options.projectRoot}:${options.compiledResultId}:${options.projectId}:${options.scenarioPath}:${options.debug}:${options.updateSnapshots}`,
          );
          return {
            passed: 1,
            failed: 0,
            results: [{ id: "first", success: true }],
          } as any;
        },
      },
    );
  } finally {
    process.exitCode = originalExitCode;
  }

  expect(calls).toEqual([
    "resolve:false",
    "portable:prod:/workspace",
    "workspace:/workspace",
    "generate:/workspace:compiled-local:project-1:test/scenarios/first.scenario.ts:true",
    "run:/workspace:compiled-local:project-1:test/scenarios/first.scenario.ts:true:true",
  ]);
});
