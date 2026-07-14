import {
  ExitCode,
  commandFailure,
  commandSuccess,
  type CommandId,
  type CommandResult,
  type JsonValue,
  type ProblemDetails,
} from "@dreamboard-games/cli-core";
import type {
  ReducerNativeScenarioResult,
  ReducerNativeScenarioSummary,
} from "./scenario-test-runner.js";

export const TEST_RUN_RESULT_SCHEMA_VERSION = 1;

export type TestRunScenarioFailure = {
  readonly code: string;
  readonly message: string;
  readonly context: Readonly<Record<string, JsonValue>>;
};

export type TestRunScenarioResult = {
  readonly id: string;
  readonly path: string;
  readonly status: "passed" | "failed";
  readonly failure?: TestRunScenarioFailure;
};

export type TestRunResult = {
  readonly schemaVersion: typeof TEST_RUN_RESULT_SCHEMA_VERSION;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
  };
  readonly scenarios: readonly TestRunScenarioResult[];
};

export type TestFailureClassification = {
  readonly problem: ProblemDetails;
  readonly exitCode: ExitCode;
};

export class TestFamilyCommandError extends Error {
  readonly command: CommandId;
  readonly problem: ProblemDetails;
  readonly exitCode: ExitCode;

  constructor(options: {
    readonly command: CommandId;
    readonly problem: ProblemDetails;
    readonly exitCode?: ExitCode;
  }) {
    super(options.problem.title);
    this.name = "TestFamilyCommandError";
    this.command = options.command;
    this.problem = options.problem;
    this.exitCode = options.exitCode ?? ExitCode.Validation;
  }
}

export function toTestCommandResult(
  summary: ReducerNativeScenarioSummary,
): CommandResult<TestRunResult> {
  const result = toTestRunResult(summary);
  if (result.summary.failed === 0) {
    return commandSuccess("test", result);
  }

  return commandFailure(
    "test",
    {
      title: "One or more scenarios failed",
      code: "TEST_SCENARIOS_FAILED",
      context: {
        total: result.summary.total,
        failed: result.summary.failed,
      },
      data: result as JsonValue,
    },
    ExitCode.Validation,
  );
}

export function toTestRunResult(
  summary: ReducerNativeScenarioSummary,
): TestRunResult {
  const scenarios = [...summary.results]
    .sort(
      (left, right) =>
        left.scenarioPath.localeCompare(right.scenarioPath) ||
        left.id.localeCompare(right.id),
    )
    .map(toTestRunScenarioResult);
  const passed = scenarios.filter(
    (scenario) => scenario.status === "passed",
  ).length;

  return {
    schemaVersion: TEST_RUN_RESULT_SCHEMA_VERSION,
    summary: {
      total: scenarios.length,
      passed,
      failed: scenarios.length - passed,
    },
    scenarios,
  };
}

export function classifyTestFamilyFailure(
  error: unknown,
  command: CommandId,
): TestFailureClassification {
  if (error instanceof TestFamilyCommandError) {
    return { problem: error.problem, exitCode: error.exitCode };
  }

  if (objectString(error, "name") === "SemanticOutputViolationError") {
    return unexpectedFailure(
      command,
      objectString(error, "category") ?? "semantic-output",
    );
  }

  const loaderCode = objectString(error, "code");
  if (objectString(error, "name") === "ScenarioLoaderError" && loaderCode) {
    const scenarioPath = objectString(error, "scenarioPath");
    switch (loaderCode) {
      case "NO_SCENARIOS_FOUND":
        return scenarioNotFoundFailure(
          scenarioPath ?? "test/scenarios/**/*.scenario.ts",
        );
      case "INVALID_SCENARIO_SELECTOR":
        if (objectString(error, "selectorReason") === "notFound") {
          return scenarioNotFoundFailure(scenarioPath ?? "");
        }
        return {
          problem: {
            title: "The scenario selector is invalid",
            code: "TEST_SCENARIO_INVALID",
            context: {
              path: scenarioPath ?? "",
              fieldPath: "scenarioPath",
            },
          },
          exitCode: ExitCode.Validation,
        };
      case "DUPLICATE_SCENARIO_ID": {
        const paths = objectStringArray(error, "scenarioPaths");
        const scenarioId = objectString(error, "scenarioId") ?? "";
        return {
          problem: {
            title: "Scenario IDs must be unique",
            code: "TEST_SCENARIO_DUPLICATE_ID",
            context: {
              scenarioId,
              firstPath: paths[0] ?? "",
              secondPath: paths[1] ?? "",
            },
            data: { scenarioId, paths },
          },
          exitCode: ExitCode.Validation,
        };
      }
      case "INVALID_SCENARIO_EXPORT":
        return scenarioInvalidFailure(error);
      case "SCENARIO_LOAD_FAILED":
        if (
          objectString(error, "causeName") ===
            "ScenarioDefinitionValidationError" ||
          objectString(error, "validationPath")
        ) {
          return scenarioInvalidFailure(error);
        }
        return unexpectedFailure(command, "scenario-loading");
      default:
        return unexpectedFailure(command, "scenario-loading");
    }
  }

  return unexpectedFailure(
    command,
    objectString(error, "name") === "CLIError"
      ? "command-validation"
      : "execution",
  );
}

function toTestRunScenarioResult(
  scenario: ReducerNativeScenarioResult,
): TestRunScenarioResult {
  if (scenario.success) {
    return {
      id: scenario.id,
      path: scenario.scenarioPath,
      status: "passed",
    };
  }

  return {
    id: scenario.id,
    path: scenario.scenarioPath,
    status: "failed",
    failure: scenarioFailure(scenario),
  };
}

function scenarioFailure(
  scenario: ReducerNativeScenarioResult,
): TestRunScenarioFailure {
  if (
    scenario.segment !== undefined &&
    scenario.index !== undefined &&
    scenario.interactionId !== undefined &&
    scenario.errorCode !== undefined
  ) {
    return {
      code: "TEST_SCENARIO_REPLAY_REJECTED",
      message: scenario.error ?? "The reducer rejected an authored command.",
      context: {
        segment: scenario.segment,
        sourceIndex: scenario.index,
        interactionId: scenario.interactionId,
        errorCode: scenario.errorCode,
      },
    };
  }

  if (scenario.validationPath !== undefined) {
    return {
      code: "TEST_SCENARIO_INVALID",
      message: scenario.error ?? "The scenario definition is invalid.",
      context: compactJsonRecord({
        fieldPath: scenario.validationPath,
        validationCode: scenario.errorCode,
      }),
    };
  }

  return {
    code: "TEST_ASSERTION_FAILED",
    message: scenario.error ?? "The scenario assertion failed.",
    context: compactJsonRecord({ assertionCode: scenario.errorCode }),
  };
}

function scenarioNotFoundFailure(path: string): TestFailureClassification {
  return {
    problem: {
      title: "The requested scenario was not found",
      code: "TEST_SCENARIO_NOT_FOUND",
      context: { requestedPath: path },
    },
    exitCode: ExitCode.Validation,
  };
}

function scenarioInvalidFailure(error: unknown): TestFailureClassification {
  return {
    problem: {
      title: "The scenario definition is invalid",
      code: "TEST_SCENARIO_INVALID",
      context: {
        path: objectString(error, "scenarioPath") ?? "",
        fieldPath: objectString(error, "validationPath") ?? "defaultExport",
      },
    },
    exitCode: ExitCode.Validation,
  };
}

function unexpectedFailure(
  _command: CommandId,
  category: string,
): TestFailureClassification {
  return {
    problem: {
      title: "The test command failed unexpectedly",
      detail:
        "The command did not complete. Retry it, then report the stable category if it repeats.",
      code: "TEST_UNEXPECTED",
      context: { category },
    },
    exitCode: ExitCode.Unexpected,
  };
}

function compactJsonRecord(
  record: Readonly<Record<string, JsonValue | undefined>>,
): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, JsonValue] => entry[1] !== undefined,
    ),
  );
}

function objectString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}

function objectStringArray(value: unknown, key: string): readonly string[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const property = (value as Record<string, unknown>)[key];
  return Array.isArray(property) &&
    property.every((entry) => typeof entry === "string")
    ? property
    : [];
}
