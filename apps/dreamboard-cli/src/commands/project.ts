import { defineCommand } from "citty";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { parseCommitScopedCommandArgs } from "../flags.js";
import { getProjectCommitStatusSdk } from "../services/api/index.js";
import type { ProjectCommitStatus } from "@dreamboard-games/api-client";
import cmdCreateProject from "./project-create.js";
import cmdCloneProject from "./project-clone.js";
import {
  printJsonOrSummary,
  resolveCommitScopedProjectContext,
} from "./commit-scoped.js";

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
  if (
    status.builds.some((build) => build.compiledArtifactStatus === "PENDING")
  ) {
    return true;
  }
  if (
    status.previews.some((preview) => preview.status === "PENDING_RETENTION")
  ) {
    return true;
  }
  return status.releases.some(
    (release) => release.status === "PENDING_RETENTION",
  );
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
    const { projectConfig, commitOid } =
      await resolveCommitScopedProjectContext(parsedArgs, parsedArgs.commit);
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

export default defineCommand({
  meta: {
    name: "project",
    description: "Manage Dreamboard projects",
  },
  subCommands: {
    create: cmdCreateProject,
    clone: cmdCloneProject,
    status: cmdProjectStatus,
  },
});
