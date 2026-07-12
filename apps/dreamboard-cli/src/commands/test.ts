import { defineCommand } from "citty";
import consola from "consola";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { resolveProjectContext } from "../config/resolve.js";
import { parseConfigFlags, type ConfigFlags } from "../flags.js";
import { assertReleaseEnvironmentPortableDependencies } from "../services/project/dependency-portability.js";
import {
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
};

export async function runTestCommand(
  args: TestCommandArgs,
  deps: TestCommandDeps = {},
): Promise<void> {
  const parsedFlags = parseConfigFlags(args);

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

  const summary = await (deps.runScenarios ?? runReducerNativeScenarios)({
    projectRoot,
    scenarioPath: args.scenario,
  });

  printTestSummary(summary);
}

function printTestSummary(summary: ReducerNativeScenarioSummary): void {
  for (const result of summary.results) {
    if (result.success) {
      consola.success(`PASS ${result.id} (${result.scenarioPath})`);
    } else if (
      result.errorCode === STALE_CONTRACT_ARTIFACT_CODE &&
      result.error
    ) {
      consola.error(result.error);
    } else {
      const commandLocation =
        result.segment !== undefined && result.index !== undefined
          ? ` ${result.segment}[${result.index}]`
          : "";
      consola.error(
        `FAIL ${result.id} (${result.scenarioPath})${commandLocation}: ${result.error ?? "Scenario failed"}`,
      );
    }
  }

  consola.info(
    `Test summary: ${summary.passed} passed, ${summary.failed} failed.`,
  );
  if (summary.failed > 0) {
    process.exitCode = resolveTestRunExitCode(summary);
  }
}

export default defineCommand({
  meta: {
    name: "test",
    description: "Replay self-contained scenarios from test/scenarios",
  },
  args: {
    scenario: {
      type: "string",
      description:
        "Optional project-relative *.scenario.ts path under test/scenarios",
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    assertNoRemovedTestFlags(process.argv.slice(2));
    await runTestCommand(args as TestCommandArgs);
  },
});
