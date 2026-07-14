import { defineCommand } from "citty";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import {
  parseConfigFlags,
  parseReleasePublishCommandArgs,
} from "../flags.js";
import { resolveProjectContext } from "../config/resolve.js";
import {
  getCurrentProjectReleaseSdk,
  publishProjectReleaseSdk,
} from "../services/api/index.js";
import {
  printJsonOrSummary,
  resolveCommitScopedProjectContext,
} from "./commit-scoped.js";

const publishCommand = defineCommand({
  meta: {
    name: "publish",
    description: "Publish a release for an exact Git commit",
  },
  args: {
    commit: {
      type: "string",
      description: "Git revision to resolve once before publishing",
      required: true,
    },
    yes: {
      type: "boolean",
      description: "Approve release publication without prompting",
      default: false,
    },
    json: {
      type: "boolean",
      description: "Print machine-readable release JSON",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseReleasePublishCommandArgs(args);
    if (!parsedArgs.yes) {
      throw new Error(
        "Release publication requires explicit approval. Re-run with --yes.",
      );
    }

    const { projectConfig, commitOid } = await resolveCommitScopedProjectContext(
      parsedArgs,
      parsedArgs.commit,
    );
    const release = await publishProjectReleaseSdk({
      projectId: projectConfig.projectId,
      commitOid,
    });

    printJsonOrSummary({
      json: parsedArgs.json,
      value: release,
      summary: [
        `Release ${release.releaseId}`,
        `status=${release.status}`,
        `retentionRef=${release.retentionRef}`,
      ].join(" "),
    });
  },
});

const currentCommand = defineCommand({
  meta: {
    name: "current",
    description: "Show the current published release",
  },
  args: {
    json: {
      type: "boolean",
      description: "Print machine-readable output",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseConfigFlags(args);
    const { projectConfig } = await resolveProjectContext(parsedArgs);
    const release = await getCurrentProjectReleaseSdk({
      projectId: projectConfig.projectId,
    });
    printJsonOrSummary({
      json: Boolean(args.json),
      value: release,
      summary: [
        `Current release ${release.releaseId}`,
        `status=${release.status}`,
        `retentionRef=${release.retentionRef}`,
      ].join(" "),
    });
  },
});

export default defineCommand({
  meta: {
    name: "release",
    description: "Manage releases",
  },
  subCommands: {
    publish: publishCommand,
    current: currentCommand,
  },
});
