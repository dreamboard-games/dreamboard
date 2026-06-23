import { defineCommand } from "citty";
import consola from "consola";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { resolveProjectContext } from "../config/resolve.js";
import { parseConfigFlags, type ConfigFlags } from "../flags.js";
import { assertReleaseEnvironmentPortableDependencies } from "../services/project/dependency-portability.js";
import {
  generateReducerNativeArtifacts,
  isReducerNativeTestingWorkspace,
  runReducerNativeScenarios,
  type ReducerNativeScenarioSummary,
} from "../services/testing/reducer-native-test-harness.js";
import {
  isStaleContractArtifactMessage,
  STALE_CONTRACT_ARTIFACT_CODE,
  STALE_CONTRACT_ARTIFACT_EXIT_CODE,
} from "../utils/errors.js";

type TestCommandArgs = ConfigFlags & {
  scenario?: string;
  debug?: boolean;
  "update-snapshots"?: boolean;
};

export type TestCommandPlan = {
  updateSnapshots: boolean;
};

export const REDUCER_NATIVE_TEST_WORKSPACE_ERROR =
  "dreamboard test requires a reducer-native workspace with app/game.ts, shared/generated/ui-contract.ts, test/bases/*.base.ts, and test/scenarios/*.scenario.ts.";

export const NO_REDUCER_NATIVE_BASES_FOUND_ERROR =
  "No bases found under test/bases/*.base.ts";

export const NO_REDUCER_NATIVE_SCENARIOS_FOUND_ERROR =
  "No scenarios found under test/scenarios/*.scenario.ts";

export function resolveTestCommandPlan(args: TestCommandArgs): TestCommandPlan {
  const updateSnapshots = Boolean(args["update-snapshots"]);

  return {
    updateSnapshots,
  };
}

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
  }
}

function isStaleContractArtifactResult(
  result: ReducerNativeScenarioSummary["results"][number],
): boolean {
  return (
    result.errorCode === STALE_CONTRACT_ARTIFACT_CODE ||
    (result.error ? isStaleContractArtifactMessage(result.error) : false)
  );
}

export function resolveTestRunExitCode(
  summary: ReducerNativeScenarioSummary,
): number {
  if (summary.failed === 0) {
    return 0;
  }
  return summary.results.some(
    (result) => !result.success && isStaleContractArtifactResult(result),
  )
    ? STALE_CONTRACT_ARTIFACT_EXIT_CODE
    : 1;
}

async function assertReducerNativeTestingWorkspace(
  projectRoot: string,
): Promise<void> {
  if (await isReducerNativeTestingWorkspace(projectRoot)) {
    return;
  }

  throw new Error(REDUCER_NATIVE_TEST_WORKSPACE_ERROR);
}

type TestCommandDeps = {
  resolveProjectContext?: typeof resolveProjectContext;
  assertPortableDependencies?: typeof assertReleaseEnvironmentPortableDependencies;
  assertTestingWorkspace?: typeof assertReducerNativeTestingWorkspace;
  runScenarios?: typeof runReducerNativeScenarios;
  generateArtifacts?: typeof generateReducerNativeArtifacts;
};

export async function runTestCommand(
  args: TestCommandArgs,
  deps: TestCommandDeps = {},
): Promise<void> {
  const parsedFlags = parseConfigFlags(args);
  const plan = resolveTestCommandPlan(args);

  const { projectRoot, projectConfig, config } = await (
    deps.resolveProjectContext ?? resolveProjectContext
  )(parsedFlags, {
    requireAuth: false,
  });
  await (
    deps.assertPortableDependencies ??
    assertReleaseEnvironmentPortableDependencies
  )({
    projectRoot,
    projectConfig,
    environment: config.environment,
  });

  await (deps.assertTestingWorkspace ?? assertReducerNativeTestingWorkspace)(
    projectRoot,
  );

  const generated = await (
    deps.generateArtifacts ?? generateReducerNativeArtifacts
  )({
    projectRoot,
    scenarioPath: args.scenario,
    compiledResultId: projectConfig.compile?.latestSuccessful?.resultId,
    projectId: projectConfig.projectId,
    debug: Boolean(args.debug),
  });
  if (generated.bases.length === 0) {
    throw new Error(NO_REDUCER_NATIVE_BASES_FOUND_ERROR);
  }
  if (generated.scenarios.length === 0) {
    throw new Error(NO_REDUCER_NATIVE_SCENARIOS_FOUND_ERROR);
  }
  const summary = await (deps.runScenarios ?? runReducerNativeScenarios)({
    projectRoot,
    projectConfig,
    resolvedConfig: config,
    scenarioPath: args.scenario,
    compiledResultId: projectConfig.compile?.latestSuccessful?.resultId,
    projectId: projectConfig.projectId,
    debug: Boolean(args.debug),
    updateSnapshots: plan.updateSnapshots,
  });

  printTestSummary(summary);
}

function printTestSummary(summary: ReducerNativeScenarioSummary): void {
  for (const result of summary.results) {
    if (result.success) {
      consola.success(`PASS ${result.id}`);
    } else if (
      result.errorCode === STALE_CONTRACT_ARTIFACT_CODE &&
      result.error
    ) {
      consola.error(result.error);
    } else {
      consola.error(`FAIL ${result.id}: ${result.error ?? "Scenario failed"}`);
    }
  }

  consola.info(
    `Test summary: ${summary.passed} passed, ${summary.failed} failed.`,
  );
  if (summary.failed > 0) {
    process.exitCode = resolveTestRunExitCode(summary);
  }
}

const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run reducer-native scenarios from test/scenarios",
  },
  args: {
    scenario: {
      type: "string",
      description: "Optional scenario file path under test/scenarios",
    },
    debug: {
      type: "boolean",
      description: "Print full reducer-native validation details",
      default: false,
    },
    "update-snapshots": {
      type: "boolean",
      description: "Refresh generated projection and scenario snapshots",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    assertNoRemovedTestFlags(process.argv.slice(2));
    await runTestCommand(args as TestCommandArgs);
  },
});

export default defineCommand({
  meta: {
    name: "test",
    description: "Reducer-native test runner with typed bases and scenarios",
  },
  args: runCommand.args,
  async run(context) {
    await runCommand.run?.(context);
  },
});
