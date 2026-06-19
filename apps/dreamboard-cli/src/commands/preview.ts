import { defineCommand } from "citty";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { parseCommitScopedCommandArgs } from "../flags.js";
import { createProjectPreviewSdk } from "../services/api/index.js";
import {
  printJsonOrSummary,
  resolveCommitScopedProjectContext,
} from "./commit-scoped.js";

export default defineCommand({
  meta: {
    name: "preview",
    description: "Create or reuse a preview for an exact Git commit",
  },
  args: {
    commit: {
      type: "string",
      description: "Git revision to resolve once before previewing",
      required: true,
    },
    json: {
      type: "boolean",
      description: "Print machine-readable preview JSON",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseCommitScopedCommandArgs("preview", args);
    const { projectConfig, commitOid } = await resolveCommitScopedProjectContext(
      parsedArgs,
      parsedArgs.commit,
    );
    const preview = await createProjectPreviewSdk({
      projectId: projectConfig.projectId,
      commitOid,
    });

    printJsonOrSummary({
      json: parsedArgs.json,
      value: preview,
      summary: [
        `Preview ${preview.previewId}`,
        `status=${preview.status}`,
        `retentionRef=${preview.retentionRef}`,
      ].join(" "),
    });
  },
});
