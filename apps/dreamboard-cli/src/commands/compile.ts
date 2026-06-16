import type { CompiledResult } from "@dreamboard-games/api-client";
import type { ProjectConfig } from "../types.js";
import { defineCommand } from "citty";
import consola from "consola";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { resolveProjectContext } from "../config/resolve.js";
import { updateProjectState } from "../config/project-config.js";
import { parseCompileCommandArgs } from "../flags.js";
import { getLocalDiff } from "../services/project/local-files.js";
import { assertCliStaticScaffoldComplete } from "../services/project/static-scaffold.js";
import {
  assertCompilerPortableDependencies,
  assertReleaseEnvironmentPortableDependencies,
} from "../services/project/dependency-portability.js";
import { runLocalTypecheck } from "../services/project/local-typecheck.js";
import {
  findProjectCompiledResultsForRevision,
  queueProjectRevisionCompileSdk,
  waitForCompiledResultJobSdk,
} from "../services/api/index.js";
import {
  getProjectAuthoringState,
  getProjectPendingAuthoringSync,
  setLatestCompileAttempt,
} from "../services/project/project-state.js";
import { formatCliError } from "../utils/errors.js";
import { resolveRemoteProject } from "../services/project/remote-project.js";

function formatDiagnosticsSummary(
  diagnostics: Array<{ message?: string }> | null | undefined,
): string | undefined {
  const firstMessage = diagnostics?.find(
    (diagnostic) => diagnostic.message,
  )?.message;
  return firstMessage?.trim() || undefined;
}

function formatCompileJobProgressMessage(job: {
  status: string;
  phase?: string;
  queuePosition?: number;
  message?: string;
}): string {
  const phase = job.phase ? ` [${job.phase}]` : "";
  const detail = job.message ? ` ${job.message}` : "";
  if (job.status === "PENDING") {
    const queue =
      typeof job.queuePosition === "number"
        ? ` (queue ${job.queuePosition + 1})`
        : "";
    return `Compile queued${queue}${phase}${detail}`.trim();
  }
  if (job.status === "RUNNING") {
    return `Compile running${phase}${detail}`.trim();
  }
  if (job.status === "FAILED") {
    return `Compile failed${phase}${detail}`.trim();
  }
  return `Compile ${job.status.toLowerCase()}${phase}${detail}`.trim();
}

function formatFailedCompileJobSummary(job: {
  phase?: string;
  message?: string | null;
  errorMessage?: string | null;
}): string {
  return formatCompileJobProgressMessage({
    status: "FAILED",
    phase: job.phase,
    message: job.errorMessage ?? job.message ?? undefined,
  });
}

function formatFailedCompileJobWithCompiledResultMessage(options: {
  compiledResultId: string;
  job: {
    phase?: string;
    message?: string | null;
    errorMessage?: string | null;
  };
}): string {
  return `${formatFailedCompileJobSummary(options.job)}. The backend created compiled result ${options.compiledResultId}, but the compile job did not complete cleanly. Run 'dreamboard compile' again after fixing the backend/compiler issue.`;
}

function formatRemoteCompileCommandError(options: {
  message: string;
  jobId?: string;
}): string {
  const detail = options.message.trim();
  const hasActionableTerminalContext =
    /^Compile\s+(failed|completed|cancelled|interrupted)\b/i.test(detail);
  if (options.jobId) {
    if (hasActionableTerminalContext) {
      return `Remote compile job ${options.jobId} could not be completed. ${detail}`;
    }
    return `Remote compile job ${options.jobId} could not be completed. ${detail} Check backend health and try 'dreamboard compile' again.`;
  }
  return `Remote compile could not be started. ${detail} Check backend health and try 'dreamboard compile' again.`;
}

async function persistFailedCompileAttempt(options: {
  projectRoot: string;
  projectConfig: ProjectConfig;
  revisionDigest: string;
  authoringStateId?: string;
  diagnosticsSummary: string;
  jobId?: string;
}): Promise<void> {
  const nextProjectConfig = setLatestCompileAttempt(options.projectConfig, {
    resultId: undefined,
    jobId: options.jobId,
    revisionDigest: options.revisionDigest,
    authoringStateId: options.authoringStateId ?? options.revisionDigest,
    status: "failed",
    diagnosticsSummary: options.diagnosticsSummary,
  });
  await updateProjectState(options.projectRoot, nextProjectConfig);
}

export default defineCommand({
  meta: {
    name: "compile",
    description: "Compile the current remote authoring head",
  },
  args: {
    debug: {
      type: "boolean",
      description: "Print additional compile progress context",
      default: false,
    },
    "skip-local-check": {
      type: "boolean",
      description: "Skip the best-effort local typecheck before compiling",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseCompileCommandArgs(args);
    const { projectRoot, projectConfig, config } =
      await resolveProjectContext(parsedArgs);
    let nextProjectConfig = projectConfig;
    await assertReleaseEnvironmentPortableDependencies({
      projectRoot,
      projectConfig: nextProjectConfig,
      environment: config.environment,
    });
    await assertCompilerPortableDependencies({
      projectRoot,
      projectConfig: nextProjectConfig,
    });

    const diff = await getLocalDiff(projectRoot);
    await assertCliStaticScaffoldComplete(projectRoot, diff.deleted);
    if (
      diff.modified.length > 0 ||
      diff.added.length > 0 ||
      diff.deleted.length > 0
    ) {
      throw new Error(
        "Local authored changes are not synced yet. Run 'dreamboard sync' before compiling.",
      );
    }

    const remoteProject = await resolveRemoteProject({
      projectRoot,
      projectConfig: nextProjectConfig,
      config,
    });
    nextProjectConfig = remoteProject.projectConfig;

    const localAuthoring = getProjectAuthoringState(nextProjectConfig);
    const pendingSync = getProjectPendingAuthoringSync(nextProjectConfig);
    if (pendingSync) {
      if (pendingSync.phase === "authoring_state_created") {
        throw new Error(
          "Previous sync reached the remote authored head, but local scaffold finalization did not complete. Run 'dreamboard sync' again before compiling.",
        );
      }
      throw new Error(
        "Previous sync uploaded source changes but did not finish creating the authored head. Run 'dreamboard sync' again before compiling.",
      );
    }
    const localRevisionDigest =
      localAuthoring.revisionDigest ?? nextProjectConfig.remoteHeadDigest;
    if (!localRevisionDigest) {
      throw new Error(
        "This workspace does not know its authored revision yet. Run 'dreamboard sync' first.",
      );
    }

    const remoteRevisionDigest = remoteProject.project.head?.revisionDigest;
    if (!remoteRevisionDigest) {
      throw new Error(
        "Remote has no authored project revision to compile yet.",
      );
    }
    if (remoteRevisionDigest !== localRevisionDigest) {
      throw new Error(
        `Remote project head is ${remoteRevisionDigest} but this workspace is based on ${localRevisionDigest}. Run 'dreamboard pull' before compiling.`,
      );
    }

    if (!parsedArgs["skip-local-check"]) {
      consola.start("Running local typecheck...");
      const typecheckResult = await runLocalTypecheck(projectRoot);
      if (typecheckResult.skipped) {
        if (typecheckResult.output) {
          consola.warn(typecheckResult.output);
        }
      } else if (!typecheckResult.success) {
        if (typecheckResult.output) {
          consola.error(typecheckResult.output);
        }
        throw new Error(
          "Local typecheck failed. Fix the diagnostics or re-run with --skip-local-check.",
        );
      } else {
        consola.success("Local typecheck passed.");
      }
    }

    const existingCompiledResult = (
      await findProjectCompiledResultsForRevision({
        projectId: nextProjectConfig.projectId,
        revisionDigest: localRevisionDigest,
      })
    ).find((result) => result.success);
    if (existingCompiledResult) {
      nextProjectConfig = setLatestCompileAttempt(nextProjectConfig, {
        resultId: existingCompiledResult.id,
        jobId: undefined,
        revisionDigest: localRevisionDigest,
        authoringStateId:
          localAuthoring.authoringStateId ?? localRevisionDigest,
        status: "successful",
        diagnosticsSummary: undefined,
      });
      await updateProjectState(projectRoot, nextProjectConfig);
      consola.success(
        `Reusing compiled ${existingCompiledResult.id} for revision ${localRevisionDigest}.`,
      );
      return;
    }

    let compileJobId: string | undefined;
    let compileJobStatus: string | undefined;
    let compileJobPhase: string | undefined;
    let compileJobMessage: string | null | undefined;
    let compileJobErrorMessage: string | null | undefined;
    let compiledResult: CompiledResult;
    try {
      const compileJob = await queueProjectRevisionCompileSdk({
        projectId: nextProjectConfig.projectId,
        revisionDigest: localRevisionDigest,
      });
      compileJobId = compileJob.jobId;
      if (!compileJobId) {
        throw new Error("Failed to create compile job: missing jobId.");
      }

      ({
        job: {
          status: compileJobStatus,
          phase: compileJobPhase,
          message: compileJobMessage,
          errorMessage: compileJobErrorMessage,
        },
        compiledResult,
      } = await waitForCompiledResultJobSdk({
        projectId: nextProjectConfig.projectId,
        jobId: compileJobId,
        onProgress: (job) => {
          const message = formatCompileJobProgressMessage(job);
          if (parsedArgs.debug) {
            consola.info(message);
          } else {
            consola.start(message);
          }
        },
      }));
    } catch (error) {
      const message = formatCliError(error);
      if (compileJobId) {
        await persistFailedCompileAttempt({
          projectRoot,
          projectConfig: nextProjectConfig,
          revisionDigest: localRevisionDigest,
          authoringStateId: localAuthoring.authoringStateId,
          diagnosticsSummary: message,
          jobId: compileJobId,
        });
      }
      throw new Error(
        formatRemoteCompileCommandError({
          message,
          jobId: compileJobId,
        }),
      );
    }

    const failedJobProducedCompiledResult =
      compileJobStatus === "FAILED" && compiledResult.success;
    const failedJobWithCompiledResultSummary = failedJobProducedCompiledResult
      ? formatFailedCompileJobSummary({
          phase: compileJobPhase,
          message: compileJobMessage,
          errorMessage: compileJobErrorMessage,
        })
      : undefined;

    nextProjectConfig = setLatestCompileAttempt(nextProjectConfig, {
      resultId: compiledResult.id,
      jobId: compileJobId,
      revisionDigest: localRevisionDigest,
      authoringStateId: localAuthoring.authoringStateId ?? localRevisionDigest,
      status:
        compiledResult.success && !failedJobProducedCompiledResult
          ? "successful"
          : "failed",
      diagnosticsSummary:
        failedJobWithCompiledResultSummary ??
        formatDiagnosticsSummary(compiledResult.diagnostics),
    });
    await updateProjectState(projectRoot, nextProjectConfig);

    if (failedJobProducedCompiledResult) {
      throw new Error(
        formatFailedCompileJobWithCompiledResultMessage({
          compiledResultId: compiledResult.id,
          job: {
            phase: compileJobPhase,
            message: compileJobMessage,
            errorMessage: compileJobErrorMessage,
          },
        }),
      );
    }

    if (!compiledResult.success) {
      for (const diagnostic of compiledResult.diagnostics ?? []) {
        if (diagnostic.message) {
          consola.error(diagnostic.message);
        }
      }
      throw new Error(
        "Remote compile failed, but your authored state is synced. Fix the diagnostics and run 'dreamboard compile' again.",
      );
    }

    consola.success(
      `Compiled ${compiledResult.id} for revision ${localRevisionDigest}.`,
    );
  },
});
