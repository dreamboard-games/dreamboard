import { defineCommand } from "citty";
import consola from "consola";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import {
  configureClient,
  requireAuth,
  resolveConfig,
} from "../config/resolve.js";
import { getStoredSession } from "../config/credential-store.js";
import { loadGlobalConfig } from "../config/global-config.js";
import {
  parseProjectRepositoryCommandArgs,
  parseCommitScopedCommandArgs,
  type ProjectRepositoryCommandArgs,
} from "../flags.js";
import {
  ensureProjectRepositorySdk,
  getProjectCommitStatusSdk,
  getProjectRepositorySdk,
  pollProjectRepository,
  retryProjectRepositoryReconciliationSdk,
} from "../services/api/index.js";
import type {
  ProjectCommitStatus,
  ProjectRepository,
} from "@dreamboard-games/api-client";
import cmdCreateProject from "./new.js";
import cmdCloneProject from "./clone.js";
import {
  printJsonOrSummary,
  resolveCommitScopedProjectContext,
} from "./commit-scoped.js";

const DEFAULT_REPOSITORY_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_REPOSITORY_POLL_INTERVAL_MS = 1_000;
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 120_000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 1_000;

function parsePositiveIntegerFlag(
  value: string | undefined,
  flagName: string,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== value) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

async function configureAuthenticatedClient(
  args: ProjectRepositoryCommandArgs,
): Promise<void> {
  const [globalConfig, storedSession] = await Promise.all([
    loadGlobalConfig(),
    getStoredSession(),
  ]);
  const config = resolveConfig(globalConfig, args, undefined, storedSession);
  requireAuth(config);
  await configureClient(config);
}

function repositorySummary(repository: ProjectRepository): string {
  const retryable = repository.retryable ? ", retryable" : "";
  const error = repository.errorCode ? `, error=${repository.errorCode}` : "";
  return [
    `state=${repository.provisioningState}`,
    `clone=${repository.cloneUrl}`,
    `defaultBranch=${repository.defaultBranch}`,
    `generation=${repository.observedGeneration}/${repository.desiredGeneration}${retryable}${error}`,
  ].join(", ");
}

async function maybePollRepository(options: {
  projectId: string;
  wait: boolean;
  timeoutMs: number;
  intervalMs: number;
  initialRepository: ProjectRepository;
}): Promise<ProjectRepository> {
  if (
    !options.wait ||
    options.initialRepository.provisioningState === "READY"
  ) {
    return options.initialRepository;
  }
  return pollProjectRepository({
    projectId: options.projectId,
    timeoutMs: options.timeoutMs,
    intervalMs: options.intervalMs,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPendingStatus(status: ProjectCommitStatus): boolean {
  if (!status.source.observed) {
    return true;
  }
  if (status.source.validationStatus === "PENDING") {
    return true;
  }
  if (status.builds.some((build) => build.compiledArtifactStatus === "PENDING")) {
    return true;
  }
  if (status.previews.some((preview) => preview.status === "PENDING_RETENTION")) {
    return true;
  }
  return status.releases.some((release) => release.status === "PENDING_RETENTION");
}

async function maybePollProjectCommitStatus(options: {
  projectId: string;
  commitOid: string;
  wait: boolean;
  timeoutMs: number;
  intervalMs: number;
  initialStatus: ProjectCommitStatus;
}): Promise<ProjectCommitStatus> {
  if (!options.wait || !isPendingStatus(options.initialStatus)) {
    return options.initialStatus;
  }

  const deadline = Date.now() + options.timeoutMs;
  let status = options.initialStatus;
  while (Date.now() < deadline) {
    await sleep(options.intervalMs);
    status = await getProjectCommitStatusSdk({
      projectId: options.projectId,
      commitOid: options.commitOid,
    });
    if (!isPendingStatus(status)) {
      return status;
    }
  }
  return status;
}

function projectStatusSummary(status: ProjectCommitStatus): string {
  const source = status.source.observed
    ? `source=${status.source.validationStatus ?? "UNKNOWN"}`
    : "source=unobserved";
  const revision = status.gameRevision.revisionDigest
    ? `revision=${status.gameRevision.revisionDigest}`
    : "revision=none";
  const builds = status.builds.length
    ? `builds=${status.builds
        .map(
          (build) =>
            `${build.targetProfile}:${build.compiledArtifactStatus ?? "NOT_QUEUED"}`,
        )
        .join(",")}`
    : "builds=none";
  const previews = status.previews.length
    ? `previews=${status.previews
        .map((preview) => `${preview.previewId}:${preview.status}`)
        .join(",")}`
    : "previews=none";
  const releases = status.releases.length
    ? `releases=${status.releases
        .map(
          (release) =>
            `${release.releaseId}:${release.status}${release.current ? ":current" : ""}`,
        )
        .join(",")}`
    : "releases=none";

  return [
    `Project ${status.projectId}`,
    `commit=${status.commitOid}`,
    source,
    revision,
    builds,
    previews,
    releases,
  ].join(" ");
}

const repositoryArgs = {
  project: {
    type: "string" as const,
    description: "Project ID",
    required: true,
  },
  wait: {
    type: "boolean" as const,
    description: "Wait for repository reconciliation to reach a terminal state",
    default: false,
  },
  "wait-timeout-ms": {
    type: "string" as const,
    description: "Maximum time to wait for Git repository setup",
  },
  "repository-poll-interval-ms": {
    type: "string" as const,
    description: "Polling interval for Git repository setup",
  },
  json: {
    type: "boolean" as const,
    description: "Print machine-readable repository JSON",
    default: false,
  },
  ...CONFIG_FLAG_ARGS,
};

async function runRepositoryCommand(
  args: unknown,
  action: (projectId: string) => Promise<ProjectRepository | null>,
): Promise<void> {
  const parsedArgs = parseProjectRepositoryCommandArgs(args);
  const waitTimeoutMs = parsePositiveIntegerFlag(
    parsedArgs["wait-timeout-ms"],
    "--wait-timeout-ms",
    DEFAULT_REPOSITORY_WAIT_TIMEOUT_MS,
  );
  const pollIntervalMs = parsePositiveIntegerFlag(
    parsedArgs["repository-poll-interval-ms"],
    "--repository-poll-interval-ms",
    DEFAULT_REPOSITORY_POLL_INTERVAL_MS,
  );
  await configureAuthenticatedClient(parsedArgs);
  const repository = await action(parsedArgs.project);
  if (!repository) {
    throw new Error(
      `Repository binding not found for project ${parsedArgs.project}.`,
    );
  }
  const finalRepository = await maybePollRepository({
    projectId: parsedArgs.project,
    wait: parsedArgs.wait,
    timeoutMs: waitTimeoutMs,
    intervalMs: pollIntervalMs,
    initialRepository: repository,
  });

  if (parsedArgs.json) {
    console.log(JSON.stringify(finalRepository, null, 2));
    return;
  }

  consola.info(repositorySummary(finalRepository));
}

const cmdProjectRepositoryGet = defineCommand({
  meta: {
    name: "get",
    description: "Show a project's Git repository binding",
  },
  args: repositoryArgs,
  async run({ args }) {
    await runRepositoryCommand(args, getProjectRepositorySdk);
  },
});

const cmdProjectRepositoryEnsure = defineCommand({
  meta: {
    name: "ensure",
    description: "Ensure a project's Git repository binding exists",
  },
  args: repositoryArgs,
  async run({ args }) {
    await runRepositoryCommand(args, ensureProjectRepositorySdk);
  },
});

const cmdProjectRepositoryRetry = defineCommand({
  meta: {
    name: "retry",
    description: "Retry Git repository reconciliation for a project",
  },
  args: repositoryArgs,
  async run({ args }) {
    await runRepositoryCommand(args, retryProjectRepositoryReconciliationSdk);
  },
});

const cmdProjectRepository = defineCommand({
  meta: {
    name: "repository",
    description: "Inspect and reconcile project Git repository bindings",
  },
  subCommands: {
    get: cmdProjectRepositoryGet,
    ensure: cmdProjectRepositoryEnsure,
    retry: cmdProjectRepositoryRetry,
  },
});

const cmdProjectStatus = defineCommand({
  meta: {
    name: "status",
    description: "Show server state for an exact Git commit",
  },
  args: {
    commit: {
      type: "string",
      description: "Git revision to resolve once before status lookup",
      required: true,
    },
    wait: {
      type: "boolean",
      description: "Wait for server-observed commit state to settle",
      default: false,
    },
    "wait-timeout-ms": {
      type: "string",
      description: "Maximum time to wait for server commit status",
    },
    "status-poll-interval-ms": {
      type: "string",
      description: "Polling interval for server commit status",
    },
    json: {
      type: "boolean",
      description: "Print machine-readable status JSON",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = {
      ...parseCommitScopedCommandArgs("project status", args),
      wait: Boolean(args.wait),
      "wait-timeout-ms":
        typeof args["wait-timeout-ms"] === "string"
          ? args["wait-timeout-ms"]
          : undefined,
      "status-poll-interval-ms":
        typeof args["status-poll-interval-ms"] === "string"
          ? args["status-poll-interval-ms"]
          : undefined,
    };
    const { projectConfig, commitOid } = await resolveCommitScopedProjectContext(
      parsedArgs,
      parsedArgs.commit,
    );
    const initialStatus = await getProjectCommitStatusSdk({
      projectId: projectConfig.projectId,
      commitOid,
    });
    const status = await maybePollProjectCommitStatus({
      projectId: projectConfig.projectId,
      commitOid,
      wait: parsedArgs.wait,
      timeoutMs: parsePositiveIntegerFlag(
        parsedArgs["wait-timeout-ms"],
        "--wait-timeout-ms",
        DEFAULT_STATUS_WAIT_TIMEOUT_MS,
      ),
      intervalMs: parsePositiveIntegerFlag(
        parsedArgs["status-poll-interval-ms"],
        "--status-poll-interval-ms",
        DEFAULT_STATUS_POLL_INTERVAL_MS,
      ),
      initialStatus,
    });

    printJsonOrSummary({
      json: parsedArgs.json,
      value: status,
      summary: projectStatusSummary(status),
    });
  },
});

function renameCommand(command: any, name: string) {
  return {
    ...command,
    meta: {
      ...command.meta,
      name,
    },
  };
}

export default defineCommand({
  meta: {
    name: "project",
    description: "Manage Dreamboard projects",
  },
  subCommands: {
    create: renameCommand(cmdCreateProject, "create"),
    clone: renameCommand(cmdCloneProject, "clone"),
    status: cmdProjectStatus,
  },
});
