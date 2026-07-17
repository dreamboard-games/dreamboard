import {
  commandSuccess,
  type CommandResult,
  type JsonValue,
} from "@dreamboard-games/cli-core";
import { defineCommand, type CommandDef } from "citty";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { resolveProjectContext } from "../config/resolve.js";
import { parseConfigFlags, type ConfigFlags } from "../flags.js";
import { assertCompilerPortableDependencies } from "../services/project/dependency-portability.js";
import {
  findReducerNativeTestingWorkspace,
  isReducerNativeTestingWorkspace,
  runReducerNativeScenarios,
} from "../services/testing/reducer-native-test-harness.js";
import {
  TestFamilyCommandError,
  toTestCommandResult,
  type TestRunResult,
} from "../services/testing/test-command-result.js";
import {
  exploreReducerNativeScenario,
  inspectReducerNativeScenario,
} from "../services/testing/scenario-inspection-service.js";

export type TestCommandArgs = ConfigFlags & {
  operation?: string;
  path?: string;
  scenario?: string;
  perspective?: string;
  at?: string;
  seed?: string;
  "seed-range"?: string;
  limit?: string;
  "max-evaluations"?: string;
  cursor?: string;
};

export type TestPerspectiveSelector =
  | { readonly kind: "player"; readonly seat: number }
  | { readonly kind: "spectator" };

export type TestCheckpointSelector =
  | { readonly segment: "setup" }
  | { readonly segment: "given" | "when"; readonly count: number }
  | { readonly checkpointId: string };

export type TestInspectServiceRequest = {
  readonly projectRoot: string;
  readonly scenarioPath: string;
  readonly perspective: TestPerspectiveSelector;
  readonly checkpoint?: TestCheckpointSelector;
  readonly seed?: number;
};

export type TestExploreServiceRequest = TestInspectServiceRequest & {
  readonly seedRange?: {
    readonly start: number;
    readonly end: number;
  };
  readonly limit?: number;
  readonly maxEvaluations: number;
  readonly cursor?: string;
};

export type TestFamilyServices = {
  readonly inspectScenario?: (
    request: TestInspectServiceRequest,
  ) => Promise<JsonValue>;
  readonly exploreScenario?: (
    request: TestExploreServiceRequest,
  ) => Promise<JsonValue>;
};

export const REDUCER_NATIVE_TEST_WORKSPACE_ERROR =
  "dreamboard test requires a reducer-native workspace with app/game.ts and test/scenarios/**/*.scenario.ts.";

export function assertNoRemovedTestFlags(argv: readonly string[]): void {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--runner" || arg.startsWith("--runner=")) {
      throw new Error(
        "dreamboard test no longer supports --runner. The public CLI runs offline reducer tests only.",
      );
    }
    if (arg === "--commit" || arg.startsWith("--commit=")) {
      throw new Error(
        "dreamboard test no longer supports --commit. Use dreamboard verify/build/preview/release with --commit for pushed-commit workflows.",
      );
    }
    if (arg === "--update-snapshots" || arg.startsWith("--update-snapshots=")) {
      throw new Error(
        "dreamboard test no longer supports --update-snapshots. Scenarios replay from authored source and do not hydrate generated snapshots.",
      );
    }
  }
}

async function assertReducerNativeTestingWorkspace(
  projectRoot: string,
): Promise<void> {
  if (await isReducerNativeTestingWorkspace(projectRoot)) {
    return;
  }

  throw new Error(REDUCER_NATIVE_TEST_WORKSPACE_ERROR);
}

export type TestCommandDeps = {
  findTestingWorkspace?: typeof findReducerNativeTestingWorkspace;
  assertLocalPortableDependencies?: typeof assertCompilerPortableDependencies;
  resolveProjectContext?: typeof resolveProjectContext;
  assertPortableDependencies?: typeof assertCompilerPortableDependencies;
  assertTestingWorkspace?: typeof assertReducerNativeTestingWorkspace;
  runScenarios?: typeof runReducerNativeScenarios;
} & TestFamilyServices;

export async function runTestCommand(
  args: TestCommandArgs,
  deps: TestCommandDeps = {},
): Promise<CommandResult<TestRunResult>> {
  const projectRoot = await resolveTestingProject(args, deps);

  const summary = await (deps.runScenarios ?? runReducerNativeScenarios)({
    projectRoot,
    scenarioPath: args.scenario,
  });

  return toTestCommandResult(summary);
}

export async function runTestFamilyCommand(
  args: TestCommandArgs,
  deps: TestCommandDeps = {},
): Promise<CommandResult<TestRunResult | JsonValue>> {
  if (args.operation === undefined) {
    assertPlainTestArgs(args);
    return runTestCommand(args, deps);
  }

  if (args.operation !== "inspect" && args.operation !== "explore") {
    throw testValidationError("test", {
      title: "The requested test operation is invalid",
      code: "TEST_SCENARIO_INVALID",
      context: { path: args.operation, fieldPath: "operation" },
    });
  }

  const command =
    args.operation === "inspect" ? "test.inspect" : "test.explore";
  const scenarioPath = requireScenarioPath(args.path, command);
  if (args.scenario !== undefined) {
    throw testValidationError(command, {
      title: "Inspect and explore use one positional scenario path",
      code: "TEST_SCENARIO_INVALID",
      context: { path: args.scenario, fieldPath: "scenario" },
    });
  }
  const perspective = parsePerspective(args.perspective, command);
  const checkpoint = parseCheckpoint(args.at, command);
  const seed = parseSafeInteger(args.seed, "seed", command);

  if (args.operation === "inspect") {
    assertNoExploreOnlyArgs(args, "test.inspect");
    const inspectScenario =
      deps.inspectScenario ?? inspectReducerNativeScenario;
    const projectRoot = await resolveTestingProject(args, deps);
    return commandSuccess(
      command,
      await inspectScenario({
        projectRoot,
        scenarioPath,
        perspective,
        checkpoint,
        seed,
      }),
    );
  }

  const seedRange = parseSeedRange(args["seed-range"], "test.explore");
  if (seed !== undefined && seedRange !== undefined) {
    throw testValidationError(command, {
      title: "Use either --seed or --seed-range, not both",
      code: "TEST_SEED_RANGE_INVALID",
      context: {
        requestedRange: args["seed-range"] ?? "",
        maximumWidth: 64,
      },
    });
  }
  if (
    seedRange !== undefined &&
    (args.limit !== undefined || args.cursor !== undefined)
  ) {
    throw testValidationError(command, {
      title: "Seed-range exploration does not use transition pagination",
      code: "TEST_EXPLORE_LIMIT_INVALID",
      context: {
        option: args.limit !== undefined ? "limit" : "cursor",
      },
    });
  }
  const limit =
    seedRange === undefined
      ? parseExploreLimit(args.limit, "test.explore")
      : undefined;
  const maxEvaluations = parseMaxEvaluations(
    args["max-evaluations"],
    "test.explore",
  );
  const exploreScenario = deps.exploreScenario ?? exploreReducerNativeScenario;
  const projectRoot = await resolveTestingProject(args, deps);
  return commandSuccess(
    command,
    await exploreScenario({
      projectRoot,
      scenarioPath,
      perspective,
      checkpoint,
      seed,
      seedRange,
      ...(limit === undefined ? {} : { limit }),
      maxEvaluations,
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    }),
  );
}

async function resolveTestingProject(
  args: TestCommandArgs,
  deps: TestCommandDeps,
): Promise<string> {
  const localWorkspace = await (
    deps.findTestingWorkspace ?? findReducerNativeTestingWorkspace
  )(process.cwd());
  if (localWorkspace) {
    await (
      deps.assertLocalPortableDependencies ?? assertCompilerPortableDependencies
    )({ projectRoot: localWorkspace });
    await (deps.assertTestingWorkspace ?? assertReducerNativeTestingWorkspace)(
      localWorkspace,
    );
    return localWorkspace;
  }

  const parsedFlags = parseConfigFlags(args);
  const { projectRoot } = await (
    deps.resolveProjectContext ?? resolveProjectContext
  )(parsedFlags, { requireAuth: false });
  await (
    deps.assertPortableDependencies ?? assertCompilerPortableDependencies
  )({ projectRoot });
  await (deps.assertTestingWorkspace ?? assertReducerNativeTestingWorkspace)(
    projectRoot,
  );
  return projectRoot;
}

function assertPlainTestArgs(args: TestCommandArgs): void {
  const unsupported = [
    ["path", args.path],
    ["perspective", args.perspective],
    ["at", args.at],
    ["seed", args.seed],
    ["seed-range", args["seed-range"]],
    ["limit", args.limit],
    ["max-evaluations", args["max-evaluations"]],
    ["cursor", args.cursor],
  ].find(([, value]) => value !== undefined);
  if (unsupported) {
    throw testValidationError("test", {
      title: "The option belongs to test inspect or test explore",
      code: "TEST_SCENARIO_INVALID",
      context: {
        path: String(unsupported[1]),
        fieldPath: unsupported[0] ?? "",
      },
    });
  }
}

function assertNoExploreOnlyArgs(
  args: TestCommandArgs,
  command: "test.inspect",
): void {
  const unsupported = [
    ["seed-range", args["seed-range"]],
    ["limit", args.limit],
    ["max-evaluations", args["max-evaluations"]],
    ["cursor", args.cursor],
  ].find(([, value]) => value !== undefined);
  if (unsupported) {
    throw testValidationError(command, {
      title: "The option is only valid for test explore",
      code: "TEST_EXPLORE_LIMIT_INVALID",
      context: {
        requested: String(unsupported[1]),
        option: unsupported[0] ?? "",
      },
    });
  }
}

function requireScenarioPath(
  value: string | undefined,
  command: "test.inspect" | "test.explore",
): string {
  if (value) {
    return value;
  }
  throw testValidationError(command, {
    title: "A project-relative scenario path is required",
    code: "TEST_SCENARIO_NOT_FOUND",
    context: { requestedPath: value ?? "" },
  });
}

function parsePerspective(
  value: string | undefined,
  command: "test.inspect" | "test.explore",
): TestPerspectiveSelector {
  if (value === "spectator") {
    return { kind: "spectator" };
  }
  const playerMatch = /^player:(0|[1-9]\d*)$/u.exec(value ?? "");
  const seat = playerMatch ? Number(playerMatch[1]) : Number.NaN;
  if (Number.isSafeInteger(seat)) {
    return { kind: "player", seat };
  }
  throw testValidationError(command, {
    title: "The requested perspective is invalid",
    code: "TEST_PERSPECTIVE_INVALID",
    context: {
      requestedPerspective: value ?? "",
      validPerspective: "spectator|player:<zero-based-seat>",
    },
  });
}

function parseCheckpoint(
  value: string | undefined,
  command: "test.inspect" | "test.explore",
): TestCheckpointSelector | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "setup") {
    return { segment: "setup" };
  }
  const match = /^(given|when):(0|[1-9]\d*)$/u.exec(value);
  const count = match ? Number(match[2]) : Number.NaN;
  if (match && Number.isSafeInteger(count)) {
    return {
      segment: match[1] as "given" | "when",
      count,
    };
  }
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) {
    return { checkpointId: value };
  }
  throw testValidationError(command, {
    title: "The requested checkpoint is invalid",
    code: "TEST_CHECKPOINT_INVALID",
    context: {
      requestedNode: value,
      validBounds:
        "<checkpoint-id>|setup|given:<completed-count>|when:<completed-count>",
    },
  });
}

function parseSafeInteger(
  value: string | undefined,
  field: string,
  command: "test.inspect" | "test.explore",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = /^-?(0|[1-9]\d*)$/u.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(parsed)) {
    return parsed;
  }
  throw testValidationError(command, {
    title: `The ${field} must be a safe integer`,
    code: "TEST_SEED_RANGE_INVALID",
    context: { requestedRange: value, maximumWidth: 64 },
  });
}

function parseSeedRange(
  value: string | undefined,
  command: "test.explore",
): { readonly start: number; readonly end: number } | undefined {
  if (value === undefined) {
    return undefined;
  }
  const match = /^(-?(?:0|[1-9]\d*)):(-?(?:0|[1-9]\d*))$/u.exec(value);
  const start = match ? Number(match[1]) : Number.NaN;
  const end = match ? Number(match[2]) : Number.NaN;
  if (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end >= start &&
    end - start + 1 <= 64
  ) {
    return { start, end };
  }
  throw testValidationError(command, {
    title: "The requested seed range is invalid",
    code: "TEST_SEED_RANGE_INVALID",
    context: { requestedRange: value, maximumWidth: 64 },
  });
}

function parseExploreLimit(
  value: string | undefined,
  command: "test.explore",
): number {
  return parseBoundedPositiveInteger({
    value,
    defaultValue: 50,
    maximum: 200,
    option: "limit",
    command,
  });
}

function parseMaxEvaluations(
  value: string | undefined,
  command: "test.explore",
): number {
  return parseBoundedPositiveInteger({
    value,
    defaultValue: 5_000,
    maximum: 5_000,
    option: "max-evaluations",
    command,
  });
}

function parseBoundedPositiveInteger(options: {
  readonly value: string | undefined;
  readonly defaultValue: number;
  readonly maximum: number;
  readonly option: string;
  readonly command: "test.explore";
}): number {
  if (options.value === undefined) {
    return options.defaultValue;
  }
  const parsed = /^(0|[1-9]\d*)$/u.test(options.value)
    ? Number(options.value)
    : Number.NaN;
  if (
    Number.isSafeInteger(parsed) &&
    parsed >= 1 &&
    parsed <= options.maximum
  ) {
    return parsed;
  }
  throw testValidationError(options.command, {
    title: `The ${options.option} value is invalid`,
    code: "TEST_EXPLORE_LIMIT_INVALID",
    context: {
      option: options.option,
      requested: options.value,
      minimum: 1,
      maximum: options.maximum,
    },
  });
}

function testValidationError(
  command: "test" | "test.inspect" | "test.explore",
  problem: ConstructorParameters<typeof TestFamilyCommandError>[0]["problem"],
): TestFamilyCommandError {
  return new TestFamilyCommandError({ command, problem });
}

export function createTestCommand(deps: TestCommandDeps = {}): CommandDef<any> {
  return defineCommand({
    meta: {
      name: "test",
      description:
        "Replay, inspect, or explore authored scenarios as one JSON envelope by default",
    },
    args: {
      operation: {
        type: "positional",
        required: false,
        description: "Optional scenario observation operation",
      },
      path: {
        type: "positional",
        required: false,
        description: "Project-relative *.scenario.ts path for inspect/explore",
      },
      scenario: {
        type: "string",
        description:
          "Optional project-relative *.scenario.ts path for a full test run",
      },
      perspective: {
        type: "string",
        description: "Required for inspect/explore: spectator or player:<seat>",
      },
      at: {
        type: "string",
        description:
          "Named scenario checkpoint, setup, given:<completed-count>, or when:<completed-count>",
      },
      seed: {
        type: "string",
        description: "Ephemeral safe-integer setup seed override",
      },
      "seed-range": {
        type: "string",
        description: "Explore an inclusive seed range with at most 64 seeds",
      },
      limit: {
        type: "string",
        description: "Explore page size from 1 to 200 (default: 50)",
      },
      "max-evaluations": {
        type: "string",
        description: "Explore evaluation budget from 1 to 5000 (default: 5000)",
      },
      cursor: {
        type: "string",
        description: "Opaque explore pagination cursor",
      },
      ...CONFIG_FLAG_ARGS,
    },
    async run({ args }) {
      assertNoRemovedTestFlags(process.argv.slice(2));
      return runTestFamilyCommand(args as TestCommandArgs, deps);
    },
  });
}

export default createTestCommand();
