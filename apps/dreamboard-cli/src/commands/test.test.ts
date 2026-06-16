import { expect, test } from "bun:test";
import {
  resolveRequestedRunner,
  resolveTestRunExitCode,
} from "./test.js";
import {
  STALE_CONTRACT_ARTIFACT_CODE,
  STALE_CONTRACT_ARTIFACT_EXIT_CODE,
} from "../utils/errors.js";

test("test runner parser accepts current runner modes", () => {
  expect(resolveRequestedRunner(undefined)).toBeUndefined();
  expect(resolveRequestedRunner("")).toBeUndefined();
  expect(resolveRequestedRunner("reducer")).toBe("reducer");
  expect(resolveRequestedRunner("remote")).toBe("remote");
  expect(resolveRequestedRunner("browser")).toBe("browser");
  expect(() => resolveRequestedRunner("legacy")).toThrow(
    "Unsupported test runner 'legacy'",
  );
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
