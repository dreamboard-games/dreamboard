import {
  ExitCode,
  type CommandId,
  type JsonValue,
} from "@dreamboard-games/cli-core";
import type {
  TestExploreServiceRequest,
  TestInspectServiceRequest,
} from "../../commands/test.js";
import {
  loadReducerNativeScenarios,
  type LoadedReducerNativeScenario,
  type ScenarioCheckpointLike,
} from "./scenario-loader.js";
import { TestFamilyCommandError } from "./test-command-result.js";

type ProblemContextValue = string | number | boolean;

export async function inspectReducerNativeScenario(
  request: TestInspectServiceRequest,
): Promise<JsonValue> {
  const scenario = await loadSelectedScenario(request);
  const at = resolveCheckpoint(scenario, request.checkpoint, "test.inspect");
  try {
    return (await scenario.inspectScenario({
      game: scenario.game,
      scenario: scenario.replayDefinition,
      identity: scenarioIdentity(scenario),
      perspective: request.perspective,
      ...(at ? { at } : {}),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
    })) as JsonValue;
  } catch (error) {
    throwStableSdkFailure(error, "test.inspect", scenario);
  }
}

export async function exploreReducerNativeScenario(
  request: TestExploreServiceRequest,
): Promise<JsonValue> {
  const scenario = await loadSelectedScenario(request);
  const at = resolveCheckpoint(scenario, request.checkpoint, "test.explore");
  try {
    return (await scenario.exploreScenario({
      game: scenario.game,
      scenario: scenario.replayDefinition,
      identity: scenarioIdentity(scenario),
      perspective: request.perspective,
      ...(at ? { at } : {}),
      ...(request.seed === undefined ? {} : { seed: request.seed }),
      ...(request.seedRange === undefined
        ? {}
        : { seedRange: request.seedRange }),
      ...(request.limit === undefined ? {} : { limit: request.limit }),
      maxEvaluations: request.maxEvaluations,
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
    })) as JsonValue;
  } catch (error) {
    throwStableSdkFailure(error, "test.explore", scenario);
  }
}

async function loadSelectedScenario(request: {
  readonly projectRoot: string;
  readonly scenarioPath: string;
}): Promise<LoadedReducerNativeScenario> {
  const scenarios = await loadReducerNativeScenarios({
    projectRoot: request.projectRoot,
    scenarioPath: request.scenarioPath,
  });
  const scenario = scenarios[0];
  if (!scenario) {
    throw new TestFamilyCommandError({
      command: "test.inspect",
      problem: {
        title: "The requested scenario was not found",
        code: "TEST_SCENARIO_NOT_FOUND",
        context: { requestedPath: request.scenarioPath },
      },
    });
  }
  return scenario;
}

function scenarioIdentity(scenario: LoadedReducerNativeScenario) {
  return {
    id: scenario.id,
    path: scenario.scenarioPath,
    sourceDigest: scenario.sourceDigest,
  };
}

function resolveCheckpoint(
  scenario: LoadedReducerNativeScenario,
  checkpoint: TestInspectServiceRequest["checkpoint"],
  command: "test.inspect" | "test.explore",
): ScenarioCheckpointLike | undefined {
  if (!checkpoint) return undefined;
  if (checkpoint.segment === "setup") {
    return { segment: "setup", completed: 0 };
  }
  const maximum = scenario.definition[checkpoint.segment].length;
  if (checkpoint.count > maximum) {
    throw new TestFamilyCommandError({
      command,
      problem: {
        title: "The requested checkpoint is outside the scenario",
        code: "TEST_CHECKPOINT_INVALID",
        context: {
          requestedNode: `${checkpoint.segment}:${checkpoint.count}`,
          segment: checkpoint.segment,
          minimumCompleted: 0,
          maximumCompleted: maximum,
        },
      },
    });
  }
  return { segment: checkpoint.segment, completed: checkpoint.count };
}

function throwStableSdkFailure(
  error: unknown,
  command: "test.inspect" | "test.explore",
  scenario: LoadedReducerNativeScenario,
): never {
  const name = objectString(error, "name");
  const code = objectString(error, "code");
  if (name === "ScenarioReplayError") {
    throw new TestFamilyCommandError({
      command,
      problem: {
        title: "The scenario prefix was rejected",
        code: "TEST_SCENARIO_REPLAY_REJECTED",
        context: compactContext({
          segment: objectString(error, "segment"),
          sourceIndex: objectNumber(error, "index"),
          interactionId: objectString(error, "interactionId"),
          errorCode: objectString(error, "errorCode"),
        }),
      },
    });
  }
  if (
    code === "TEST_PERSPECTIVE_INVALID" ||
    code === "TEST_SEED_RANGE_INVALID" ||
    code === "TEST_EXPLORE_LIMIT_INVALID"
  ) {
    throw new TestFamilyCommandError({
      command,
      problem: {
        title: stableFailureTitle(code),
        code,
        context: errorContext(error),
      },
    });
  }
  if (code === "TEST_EXPLORE_CURSOR_STALE") {
    throw new TestFamilyCommandError({
      command,
      problem: {
        title: "The exploration cursor is stale",
        code,
        context: compactContext({
          scenarioDigest:
            objectString(error, "scenarioSourceDigest") ??
            scenario.sourceDigest,
          checkpointDigest: objectString(error, "checkpointDigest"),
        }),
      },
      exitCode: ExitCode.Conflict,
    });
  }
  if (code === "TEST_SCENARIO_INVALID") {
    throw new TestFamilyCommandError({
      command,
      problem: {
        title: "The scenario definition is invalid",
        code,
        context: {
          path: scenario.scenarioPath,
          ...errorContext(error),
        },
      },
    });
  }
  throw error;
}

function stableFailureTitle(code: string): string {
  switch (code) {
    case "TEST_PERSPECTIVE_INVALID":
      return "The requested perspective is invalid";
    case "TEST_SEED_RANGE_INVALID":
      return "The requested seed range is invalid";
    default:
      return "The exploration limit is invalid";
  }
}

function errorContext(
  error: unknown,
): Readonly<Record<string, ProblemContextValue>> {
  if (typeof error !== "object" || error === null) return {};
  const context = (error as { readonly context?: unknown }).context;
  if (
    typeof context !== "object" ||
    context === null ||
    Array.isArray(context)
  ) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(context).filter(
      (entry): entry is [string, ProblemContextValue] =>
        isProblemContextValue(entry[1]),
    ),
  );
}

function compactContext(
  values: Readonly<Record<string, ProblemContextValue | undefined>>,
): Readonly<Record<string, ProblemContextValue>> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, ProblemContextValue] => entry[1] !== undefined,
    ),
  );
}

function isProblemContextValue(value: unknown): value is ProblemContextValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function objectString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}

function objectNumber(value: unknown, key: string): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "number" ? property : undefined;
}
