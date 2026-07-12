import path from "node:path";
import { exists } from "../../utils/fs.js";
import {
  isStaleContractArtifactError,
  STALE_CONTRACT_ARTIFACT_CODE,
} from "../../utils/errors.js";
import {
  loadReducerNativeScenarios,
  type LoadedReducerNativeScenario,
} from "./scenario-loader.js";

export type ReducerNativeScenarioResult = {
  readonly id: string;
  readonly scenarioPath: string;
  readonly sourceDigest: string;
  readonly sdkVersion: string;
  readonly success: boolean;
  readonly error?: string;
  readonly errorCode?: string;
  readonly validationPath?: string;
  readonly segment?: "given" | "when";
  readonly index?: number;
  readonly interactionId?: string;
  readonly reducerMessage?: string;
  readonly trace?: readonly unknown[];
};

export type ReducerNativeScenarioSummary = {
  readonly sdkVersion: string;
  readonly passed: number;
  readonly failed: number;
  readonly results: readonly ReducerNativeScenarioResult[];
};

export async function isReducerNativeTestingWorkspace(
  projectRoot: string,
): Promise<boolean> {
  return exists(path.join(projectRoot, "app", "game.ts"));
}

export async function runReducerNativeScenarios(options: {
  readonly projectRoot: string;
  readonly scenarioPath?: string;
}): Promise<ReducerNativeScenarioSummary> {
  const scenarios = await loadReducerNativeScenarios(options);
  const results: ReducerNativeScenarioResult[] = [];

  for (const scenario of scenarios) {
    results.push(await runScenario(scenario));
  }

  const passed = results.filter((result) => result.success).length;
  return {
    sdkVersion: scenarios[0]!.sdkVersion,
    passed,
    failed: results.length - passed,
    results,
  };
}

async function runScenario(
  scenario: LoadedReducerNativeScenario,
): Promise<ReducerNativeScenarioResult> {
  const common = {
    id: scenario.id,
    scenarioPath: scenario.scenarioPath,
    sourceDigest: scenario.sourceDigest,
    sdkVersion: scenario.sdkVersion,
  } as const;

  try {
    const replay = await scenario.replayScenario({
      game: scenario.game,
      scenario: scenario.replayDefinition,
    });
    await scenario.assertScenario({
      replay,
      assertion: scenario.definition.then,
    });
    return { ...common, success: true };
  } catch (error) {
    const failure = structuredScenarioFailure(scenario, error);
    return {
      ...common,
      success: false,
      error: errorMessage(error),
      ...failure,
    };
  }
}

function structuredScenarioFailure(
  scenario: LoadedReducerNativeScenario,
  error: unknown,
): Omit<
  ReducerNativeScenarioResult,
  "id" | "scenarioPath" | "sourceDigest" | "sdkVersion" | "success" | "error"
> {
  if (
    error instanceof scenario.ScenarioReplayError ||
    objectString(error, "name") === "ScenarioReplayError"
  ) {
    return {
      errorCode: objectString(error, "errorCode"),
      segment: replaySegment(error),
      index: objectNumber(error, "index"),
      interactionId: objectString(error, "interactionId"),
      reducerMessage: objectString(error, "reducerMessage"),
      trace: objectArray(error, "trace"),
    };
  }
  if (
    error instanceof scenario.ScenarioDefinitionValidationError ||
    objectString(error, "name") === "ScenarioDefinitionValidationError"
  ) {
    return {
      errorCode: objectString(error, "code"),
      validationPath: objectString(error, "path"),
    };
  }
  if (isStaleContractArtifactError(error)) {
    return { errorCode: STALE_CONTRACT_ARTIFACT_CODE };
  }
  return {
    errorCode: objectString(error, "errorCode") ?? objectString(error, "code"),
  };
}

function replaySegment(error: unknown): "given" | "when" | undefined {
  const segment = objectString(error, "segment");
  return segment === "given" || segment === "when" ? segment : undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}

function objectNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" ? property : undefined;
}

function objectArray(
  value: unknown,
  key: string,
): readonly unknown[] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return Array.isArray(property) ? property : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return typeof error === "string" ? error : "Scenario failed.";
}
