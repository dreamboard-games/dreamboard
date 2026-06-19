import { defineCommand } from "citty";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { parseBuildCommandArgs } from "../flags.js";
import { ensureProjectBuildSdk } from "../services/api/index.js";
import {
  printJsonOrSummary,
  resolveCommitScopedProjectContext,
} from "./commit-scoped.js";

export default defineCommand({
  meta: {
    name: "build",
    description: "Ensure a server build exists for an exact Git commit",
  },
  args: {
    commit: {
      type: "string",
      description: "Git revision to resolve once before building",
      required: true,
    },
    profile: {
      type: "string",
      valueHint: "preview|release",
      description: "Build profile",
      default: "preview",
    },
    json: {
      type: "boolean",
      description: "Print machine-readable build JSON",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseBuildCommandArgs(args);
    const { projectConfig, commitOid } = await resolveCommitScopedProjectContext(
      parsedArgs,
      parsedArgs.commit,
    );
    const build = await ensureProjectBuildSdk({
      projectId: projectConfig.projectId,
      commitOid,
      targetProfile: parsedArgs.profile,
    });

    printJsonOrSummary({
      json: parsedArgs.json,
      value: build,
      summary: [
        `Build ${build.buildRecipeDigest}`,
        `commit=${build.commitOid}`,
        `profile=${build.targetProfile}`,
        `artifact=${build.compiledArtifactStatus}`,
      ].join(" "),
    });
  },
});
