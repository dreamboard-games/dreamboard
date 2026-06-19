import {
  ensureProjectRepository,
  getProjectRepository,
  retryProjectRepositoryReconciliation,
  type ProjectRepository,
  type ProjectRepositoryProvisioningState,
} from "@dreamboard-games/api-client";
import { toDreamboardApiError } from "../../utils/errors.js";

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const TERMINAL_STATES = new Set<ProjectRepositoryProvisioningState>([
  "READY",
  "ERROR",
  "DELETING",
  "DELETED",
]);

export class ProjectRepositoryTimeoutError extends Error {
  readonly lastRepository: ProjectRepository | null;

  constructor(options: {
    projectId: string;
    timeoutMs: number;
    lastRepository: ProjectRepository | null;
  }) {
    const state = options.lastRepository?.provisioningState ?? "unknown";
    super(
      `Repository setup for project ${options.projectId} timed out after ${options.timeoutMs}ms (last state: ${state}).`,
    );
    this.name = "ProjectRepositoryTimeoutError";
    this.lastRepository = options.lastRepository;
  }
}

export async function ensureProjectRepositorySdk(
  projectId: string,
): Promise<ProjectRepository> {
  const { data, error, response } = await ensureProjectRepository({
    path: { projectId },
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to ensure project repository",
    );
  }

  return data;
}

export async function getProjectRepositorySdk(
  projectId: string,
): Promise<ProjectRepository | null> {
  const { data, error, response } = await getProjectRepository({
    path: { projectId },
  });

  if (response?.status === 404) {
    return null;
  }
  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to fetch project repository",
    );
  }

  return data;
}

export async function retryProjectRepositoryReconciliationSdk(
  projectId: string,
): Promise<ProjectRepository> {
  const { data, error, response } = await retryProjectRepositoryReconciliation({
    path: { projectId },
  });

  if (error || !data) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to retry project repository reconciliation",
    );
  }

  return data;
}

export async function pollProjectRepository(options: {
  projectId: string;
  timeoutMs: number;
  intervalMs?: number;
  fetchRepository?: (projectId: string) => Promise<ProjectRepository | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<ProjectRepository> {
  const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const fetchRepository = options.fetchRepository ?? getProjectRepositorySdk;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? (() => Date.now());
  const deadline = now() + options.timeoutMs;
  let lastRepository: ProjectRepository | null = null;

  while (now() <= deadline) {
    lastRepository = await fetchRepository(options.projectId);
    if (
      lastRepository &&
      TERMINAL_STATES.has(lastRepository.provisioningState)
    ) {
      return lastRepository;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(intervalMs, remainingMs));
  }

  throw new ProjectRepositoryTimeoutError({
    projectId: options.projectId,
    timeoutMs: options.timeoutMs,
    lastRepository,
  });
}
