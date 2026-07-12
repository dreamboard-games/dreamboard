import {
  runReducerNativeScenarios,
  type ReducerNativeScenarioResult,
  type ReducerNativeScenarioSummary,
} from "./reducer-native-test-harness.js";

export type ReducerNativeScenarioRunner = typeof runReducerNativeScenarios;

export async function requirePassingReducerNativeScenarios(
  options: {
    projectRoot: string;
    verificationLabel: string;
  },
  deps: {
    runScenarios?: ReducerNativeScenarioRunner;
  } = {},
): Promise<ReducerNativeScenarioSummary> {
  const summary = await (deps.runScenarios ?? runReducerNativeScenarios)({
    projectRoot: options.projectRoot,
  });

  if (summary.results.length === 0) {
    throw new Error("No scenarios found under test/scenarios/*.scenario.ts.");
  }
  if (summary.failed > 0) {
    const failures = summary.results
      .filter((result) => !result.success)
      .map(formatReducerNativeScenarioFailure);
    throw new Error(
      [
        `${options.verificationLabel} failed: ${summary.failed} failed, ${summary.passed} passed.`,
        ...failures,
      ].join("\n"),
    );
  }

  return summary;
}

export function formatReducerNativeScenarioFailure(
  result: ReducerNativeScenarioResult,
): string {
  const context = [
    result.scenarioPath,
    result.validationPath ? `validation ${result.validationPath}` : null,
    result.segment && result.index !== undefined
      ? `${result.segment}[${result.index}]`
      : null,
    result.interactionId ? `interaction ${result.interactionId}` : null,
    result.errorCode ? `code ${result.errorCode}` : null,
  ].filter((value): value is string => Boolean(value));
  return `FAIL ${result.id}${context.length > 0 ? ` (${context.join(", ")})` : ""}: ${result.error ?? "failed"}`;
}
