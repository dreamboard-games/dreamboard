import {
  getJob,
  getProjectCompiledResult,
  listProjectCompiledResults,
  queueProjectRevisionCompile,
  type CompiledResult,
  type JobDetailResponse,
  type QueueCompiledResultJobResponse,
} from "@dreamboard-games/api-client";
import { toDreamboardApiError } from "../../utils/errors.js";

const COMPILE_JOB_POLL_INTERVAL_MS = 1000;
const DEFAULT_COMPILE_JOB_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
import { sleep } from "../../utils/strings.js";

function firstNonEmpty(
  ...values: Array<string | null | undefined>
): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function formatTerminalCompileJobMessage(
  job: Pick<
    JobDetailResponse,
    "createdAt" | "errorMessage" | "jobId" | "message" | "phase" | "status"
  >,
): string {
  const detail = firstNonEmpty(job.errorMessage, job.message);
  const phase = firstNonEmpty(job.phase);
  const prefix = `Compile ${job.status.toLowerCase()}${phase ? ` [${phase}]` : ""}`;
  return detail
    ? `${prefix}: ${detail}`
    : `${prefix}: job ${job.jobId} ended before a compiled result was created.`;
}

function compareCreatedAtDesc(
  left: Pick<CompiledResult, "createdAt">,
  right: Pick<CompiledResult, "createdAt">,
): number {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime - leftTime;
  }
  if (Number.isFinite(rightTime)) {
    return 1;
  }
  if (Number.isFinite(leftTime)) {
    return -1;
  }
  return 0;
}

async function findFallbackCompiledResultForJob(options: {
  projectId?: string;
  job: Pick<JobDetailResponse, "createdAt">;
}): Promise<CompiledResult | null> {
  const { projectId, job } = options;
  if (!projectId) {
    return null;
  }
  const results = await listProjectCompiledResults({
    path: { projectId },
    query: { limit: 100 },
  });
  if (results.error || !results.data) {
    return null;
  }
  if (results.data.results.length === 0) {
    return null;
  }

  const jobCreatedAtMs = Date.parse(job.createdAt);
  const resultsCreatedAfterJob = Number.isFinite(jobCreatedAtMs)
    ? results.data.results.filter((result) => {
        const resultCreatedAtMs = Date.parse(result.createdAt);
        return (
          !Number.isFinite(resultCreatedAtMs) ||
          resultCreatedAtMs >= jobCreatedAtMs
        );
      })
    : results.data.results;
  const candidateResults =
    resultsCreatedAfterJob.length > 0
      ? resultsCreatedAfterJob
      : results.data.results;

  return [...candidateResults].sort(compareCreatedAtDesc)[0] ?? null;
}

export async function findLatestSuccessfulCompiledResult(
  projectId: string,
): Promise<CompiledResult | null> {
  void projectId;
  return null;
}

export async function findCompiledResultsForAuthoringState(options: {
  projectId: string;
  authoringStateId: string;
}): Promise<CompiledResult[]> {
  void options;
  return [];
}

export async function getCompiledResultSdk(
  projectId: string,
  compiledResultId: string,
): Promise<CompiledResult> {
  void projectId;
  void compiledResultId;
  throw new Error("Project-scoped compiled result lookup is no longer supported.");
}

export async function findProjectCompiledResultsForRevision(options: {
  projectId: string;
  revisionDigest: string;
}): Promise<CompiledResult[]> {
  const { projectId, revisionDigest } = options;
  const { data, error, response } = await listProjectCompiledResults({
    path: { projectId },
    query: { limit: 100 },
  });
  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to list compiled results",
    );
  }
  return data.results.filter(
    (result) => result.revisionDigest === revisionDigest,
  );
}

export async function getProjectCompiledResultSdk(
  projectId: string,
  compiledResultId: string,
): Promise<CompiledResult> {
  const { data, error, response } = await getProjectCompiledResult({
    path: { projectId, compiledResultId },
  });
  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to fetch compiled result",
    );
  }
  return data;
}

export async function queueProjectRevisionCompileSdk(options: {
  projectId: string;
  revisionDigest: string;
}): Promise<QueueCompiledResultJobResponse> {
  const { data, error, response } = await queueProjectRevisionCompile({
    path: {
      projectId: options.projectId,
      revisionDigest: options.revisionDigest,
    },
  });

  if (error || !data) {
    throw toDreamboardApiError(error, response, "Failed to create compile job");
  }

  return data;
}

export async function waitForCompiledResultJobSdk(options: {
  projectId?: string;
  jobId: string;
  onProgress?: (job: JobDetailResponse) => void;
}): Promise<{
  job: JobDetailResponse;
  compiledResult: CompiledResult;
}> {
  const { projectId, jobId, onProgress } = options;
  if (!projectId) {
    throw new Error("projectId is required when waiting for a compile job.");
  }
  let previousTransitionKey: string | null = null;
  const startedAt = Date.now();
  const timeoutMs = readCompileJobWaitTimeoutMs();

  while (Date.now() - startedAt < timeoutMs) {
    const {
      data: job,
      error,
      response,
    } = await getJob({
      path: { jobId },
    });
    if (error || !job) {
      if (isTransientJobPollError(error, response)) {
        await sleep(COMPILE_JOB_POLL_INTERVAL_MS);
        continue;
      }
      throw toDreamboardApiError(error, response, "Failed to get job");
    }

    const transitionKey = `${job.status}:${job.phase ?? ""}`;
    if (transitionKey !== previousTransitionKey) {
      previousTransitionKey = transitionKey;
      onProgress?.(job);
    }

    if (job.status === "COMPLETED" || job.status === "FAILED") {
      const compiledResultId =
        job.createdCompiledResultId ?? job.createdAppScriptId;
      if (compiledResultId) {
        const compiledResult = await getProjectCompiledResultSdk(
          projectId,
          compiledResultId,
        );
        return { job, compiledResult };
      }

      const fallbackCompiledResult = await findFallbackCompiledResultForJob({
        projectId,
        job,
      });
      if (fallbackCompiledResult) {
        return { job, compiledResult: fallbackCompiledResult };
      }

      throw new Error(formatTerminalCompileJobMessage(job));
    }

    if (job.status === "CANCELLED" || job.status === "INTERRUPTED") {
      throw new Error(formatTerminalCompileJobMessage(job));
    }

    await sleep(COMPILE_JOB_POLL_INTERVAL_MS);
  }

  throw new Error(`Compile job ${jobId} did not complete in time.`);
}

function readCompileJobWaitTimeoutMs(): number {
  const raw = process.env.DREAMBOARD_COMPILE_WAIT_TIMEOUT_MS;
  if (!raw) return DEFAULT_COMPILE_JOB_WAIT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_COMPILE_JOB_WAIT_TIMEOUT_MS;
  }
  return parsed;
}

function isTransientJobPollError(error: unknown, response: unknown): boolean {
  if (response) return false;
  if (!error) return false;
  if (error instanceof Error) {
    return isTransientJobPollMessage(error.message);
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return isTransientJobPollMessage(String(error.message));
  }
  return isTransientJobPollMessage(String(error));
}

function isTransientJobPollMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("socket")
  );
}
