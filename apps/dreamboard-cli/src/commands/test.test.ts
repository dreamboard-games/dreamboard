import { expect, test } from "bun:test";
import {
  assertNoRemovedTestFlags,
  runTestCommand,
  resolveTestRunExitCode,
} from "./test.js";
import {
  STALE_CONTRACT_ARTIFACT_CODE,
  STALE_CONTRACT_ARTIFACT_EXIT_CODE,
} from "../utils/errors.js";

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

test("stale contract artifact failures use the dedicated exit code", () => {
  const exitCode = resolveTestRunExitCode({
    passed: 0,
    failed: 1,
    results: [
      {
        id: "scenario-1",
        scenarioPath: "test/scenarios/scenario-1.scenario.ts",
        sourceDigest: "sha256:scenario-1",
        sdkVersion: "0.4.0-test",
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
        runScenarios: async (options) => {
          calls.push(`run:${options.projectRoot}:${options.scenarioPath}`);
          return {
            sdkVersion: "0.4.0-test",
            passed: 1,
            failed: 0,
            results: [
              {
                id: "first",
                scenarioPath: "test/scenarios/first.scenario.ts",
                sourceDigest: "sha256:first",
                sdkVersion: "0.4.0-test",
                success: true,
              },
            ],
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
    "run:/workspace:test/scenarios/first.scenario.ts",
  ]);
});
