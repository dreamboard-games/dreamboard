import { defineCommand } from "citty";
import consola from "consola";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { configureClient, resolveProjectContext } from "../config/resolve.js";
import { parseConfigFlags } from "../flags.js";
import { uploadInitialProjectionSdk } from "../services/api/index.js";
import { assertReleaseEnvironmentPortableDependencies } from "../services/project/dependency-portability.js";
import {
  generateReducerNativeArtifacts,
  isReducerNativeTestingWorkspace,
  runReducerNativeScenarios,
  type ReducerNativeScenarioSummary,
} from "../services/testing/reducer-native-test-harness.js";
import { shouldUseRemoteTestRuntime } from "../services/testing/runtime-mode.js";
import { resolveLatestCompiledResult } from "../services/workflows/resolve-latest-compiled-result.js";
import type { ProjectConfig } from "../types.js";
import {
  isDreamboardApiError,
  isStaleContractArtifactMessage,
  STALE_CONTRACT_ARTIFACT_CODE,
  STALE_CONTRACT_ARTIFACT_EXIT_CODE,
} from "../utils/errors.js";

type RequestedTestRunner = "reducer" | "remote" | "browser";

export const REDUCER_NATIVE_TEST_WORKSPACE_ERROR =
  "dreamboard test now requires a reducer-native workspace with app/game.ts, shared/generated/ui-contract.ts, test/bases/*.base.ts, and test/scenarios/*.scenario.ts. Legacy test/base-scenarios.json workspaces are no longer supported.";

export const NO_REDUCER_NATIVE_BASES_FOUND_ERROR =
  "No bases found under test/bases/*.base.ts";

export const NO_REDUCER_NATIVE_SCENARIOS_FOUND_ERROR =
  "No scenarios found under test/scenarios/*.scenario.ts";

export function isPreviewProjectionEndpointUnavailable(
  error: unknown,
): boolean {
  if (!isDreamboardApiError(error) || error.status !== 404) {
    return false;
  }

  const endpoint = error.problem.instance ?? error.problem.context?.endpoint;
  const message = error.problem.detail ?? error.problem.title;
  return (
    endpoint?.includes("/preview/initial-projection") === true &&
    message?.toLowerCase() === "not found"
  );
}

async function uploadGeneratedPreviewProjection(options: {
  projectRoot: string;
  gameId: string;
  bases: Array<{ definition: { id: string } }>;
}): Promise<void> {
  const previewBase =
    options.bases.find((base) => base.definition.id === "initial-turn") ??
    options.bases[0];
  if (!previewBase) {
    return;
  }
  const projectionPath = path.join(
    options.projectRoot,
    "test",
    "generated",
    "bases",
    previewBase.definition.id,
    "player-1.projection.json",
  );
  const projectionJson = await readFile(projectionPath, "utf8");
  try {
    await uploadInitialProjectionSdk(options.gameId, projectionJson);
  } catch (error) {
    if (isPreviewProjectionEndpointUnavailable(error)) {
      consola.warn(
        "Skipping preview projection upload because the selected backend does not expose the preview projection endpoint.",
      );
      return;
    }
    throw error;
  }
}

export function resolveRequestedRunner(
  value: unknown,
): RequestedTestRunner | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (value === "reducer" || value === "remote" || value === "browser") {
    return value;
  }
  throw new Error(
    `Unsupported test runner '${String(value)}'. Expected one of reducer, remote, browser.`,
  );
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

async function resolveReducerNativeRuntimeIdentity(options: {
  projectRoot: string;
  projectConfig: ProjectConfig;
  useRemoteRuntime: boolean;
  runner?: RequestedTestRunner;
}): Promise<{
  gameId: string;
  compiledResultId?: string;
}> {
  if (
    options.useRemoteRuntime ||
    options.runner === "remote" ||
    options.runner === "browser"
  ) {
    const latestCompiledResult = await resolveLatestCompiledResult(
      options.projectRoot,
      options.projectConfig,
    );
    return {
      gameId: options.projectConfig.gameId,
      compiledResultId: latestCompiledResult.id,
    };
  }

  return {
    gameId: options.projectConfig.gameId,
    compiledResultId: options.projectConfig.compile?.latestSuccessful?.resultId,
  };
}

const generateCommand = defineCommand({
  meta: {
    name: "generate",
    description: "Generate reducer-native base artifacts for typed scenarios",
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
    const parsedFlags = parseConfigFlags(args);
    const useRemoteRuntime = shouldUseRemoteTestRuntime(parsedFlags.env);
    const { projectRoot, projectConfig, config } = await resolveProjectContext(
      parsedFlags,
      { requireAuth: useRemoteRuntime },
    );
    await assertReleaseEnvironmentPortableDependencies({
      projectRoot,
      projectConfig,
      environment: config.environment,
    });

    await assertReducerNativeTestingWorkspace(projectRoot);

    const runtimeIdentity = await resolveReducerNativeRuntimeIdentity({
      projectRoot,
      projectConfig,
      useRemoteRuntime,
    });
    const { bases, scenarios } = await generateReducerNativeArtifacts({
      projectRoot,
      scenarioPath: args.scenario,
      compiledResultId: runtimeIdentity.compiledResultId,
      gameId: runtimeIdentity.gameId,
      debug: Boolean(args.debug),
    });

    if (bases.length === 0) {
      throw new Error(NO_REDUCER_NATIVE_BASES_FOUND_ERROR);
    }
    if (scenarios.length === 0) {
      throw new Error(NO_REDUCER_NATIVE_SCENARIOS_FOUND_ERROR);
    }

    if (useRemoteRuntime && (config.authToken || config.refreshToken)) {
      await configureClient(config);
      await uploadGeneratedPreviewProjection({
        projectRoot,
        gameId: runtimeIdentity.gameId,
        bases,
      });
    } else {
      consola.info(
        "Skipping preview projection upload because this test generation is local-only.",
      );
    }

    consola.success(
      `Generated ${bases.length} base state(s) for ${scenarios.length} scenario(s).`,
    );
  },
});

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
    runner: {
      type: "string",
      valueHint: "reducer|remote|browser",
      description:
        "Scenario runner: reducer (in-process, default), remote (live sessions against the configured backend), or browser (local web stack).",
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedFlags = parseConfigFlags(args);
    const useRemoteRuntime = shouldUseRemoteTestRuntime(parsedFlags.env);
    const runner = resolveRequestedRunner(args.runner) ?? "reducer";
    const { projectRoot, projectConfig, config } = await resolveProjectContext(
      parsedFlags,
      {
        requireAuth:
          useRemoteRuntime || runner === "remote" || runner === "browser",
      },
    );
    await assertReleaseEnvironmentPortableDependencies({
      projectRoot,
      projectConfig,
      environment: config.environment,
    });

    await assertReducerNativeTestingWorkspace(projectRoot);

    const runtimeIdentity = await resolveReducerNativeRuntimeIdentity({
      projectRoot,
      projectConfig,
      useRemoteRuntime,
      runner,
    });
    const summary = await runReducerNativeScenarios({
      projectRoot,
      projectConfig,
      resolvedConfig: config,
      runner,
      scenarioPath: args.scenario,
      compiledResultId: runtimeIdentity.compiledResultId,
      gameId: runtimeIdentity.gameId,
      debug: Boolean(args.debug),
      updateSnapshots: Boolean(args["update-snapshots"]),
    });

    for (const result of summary.results) {
      if (result.success) {
        consola.success(`PASS ${result.id}`);
      } else if (
        result.errorCode === STALE_CONTRACT_ARTIFACT_CODE &&
        result.error
      ) {
        consola.error(result.error);
      } else {
        consola.error(
          `FAIL ${result.id}: ${result.error ?? "Scenario failed"}`,
        );
      }
    }

    consola.info(
      `Test summary: ${summary.passed} passed, ${summary.failed} failed.`,
    );
    if (summary.failed > 0) {
      process.exitCode = resolveTestRunExitCode(summary);
    }
  },
});

export default defineCommand({
  meta: {
    name: "test",
    description: "Reducer-native test runner with typed bases and scenarios",
  },
  subCommands: {
    generate: generateCommand,
    run: runCommand,
  },
});
