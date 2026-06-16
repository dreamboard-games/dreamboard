import { defineCommand } from "citty";
import consola from "consola";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { resolveProjectContext, configureClient } from "../config/resolve.js";
import { resolveLocalHarnessAccessToken } from "../config/local-harness-auth.js";
import { parseStatusCommandArgs } from "../flags.js";
import { getLocalDiff } from "../services/project/local-files.js";
import { findProjectCompiledResultsForRevision } from "../services/api/index.js";
import {
  getProjectAuthoringState,
  getProjectCompileState,
  getProjectPendingAuthoringSync,
} from "../services/project/project-state.js";
import { resolveRemoteProject } from "../services/project/remote-project.js";

export default defineCommand({
  meta: { name: "status", description: "Show local vs remote status" },
  args: {
    json: {
      type: "boolean",
      description: "Print machine-readable status JSON",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseStatusCommandArgs(args);
    const { projectRoot, projectConfig, config } = await resolveProjectContext(
      parsedArgs,
      { requireAuth: false },
    );

    const diff = await getLocalDiff(projectRoot);
    const localAuthoring = getProjectAuthoringState(projectConfig);
    const pendingSync = getProjectPendingAuthoringSync(projectConfig);
    const localCompile = getProjectCompileState(projectConfig);
    let remoteHeadId: string | null = null;
    let authoredRelation:
      | "in_sync"
      | "ahead"
      | "behind"
      | "diverged"
      | "pending_finalize"
      | "unknown" = "unknown";
    let compileRelation:
      | "successful"
      | "failed"
      | "never_compiled"
      | "stale_success" = "never_compiled";
    let verified: boolean | null = null;
    let verifiedAt: string | null = null;
    const hasAuth =
      Boolean(config.authToken || config.refreshToken) ||
      Boolean(resolveLocalHarnessAccessToken(config));

    if (hasAuth) {
      await configureClient(config);
      const remoteProject = await resolveRemoteProject({
        projectRoot,
        projectConfig,
        config,
      });
      remoteHeadId = remoteProject.project.head?.revisionDigest ?? null;

      const hasLocalDiff =
        diff.modified.length > 0 ||
        diff.added.length > 0 ||
        diff.deleted.length > 0;
      if (pendingSync) {
        authoredRelation = "pending_finalize";
      } else if (!localAuthoring.revisionDigest) {
        authoredRelation = "unknown";
      } else if (remoteHeadId === null) {
        authoredRelation = hasLocalDiff ? "ahead" : "unknown";
      } else if (remoteHeadId === localAuthoring.revisionDigest) {
        authoredRelation = hasLocalDiff ? "ahead" : "in_sync";
      } else {
        authoredRelation = hasLocalDiff ? "diverged" : "behind";
      }

      if (remoteHeadId) {
        const remoteResults = await findProjectCompiledResultsForRevision({
          projectId: projectConfig.projectId,
          revisionDigest: remoteHeadId,
        });
        const latestAttempt = remoteResults[0] ?? null;

        if (latestAttempt?.success) {
          compileRelation = "successful";
        } else if (latestAttempt && !latestAttempt.success) {
          compileRelation = "failed";
        } else if (
          localCompile.latestSuccessful &&
          localCompile.latestSuccessful.revisionDigest !== remoteHeadId
        ) {
          compileRelation = "stale_success";
        } else {
          compileRelation = "never_compiled";
        }
      }
    }

    if (parsedArgs.json) {
      console.log(
        JSON.stringify(
          {
            projectId: projectConfig.projectId,
            slug: projectConfig.slug,
            authoring: {
              localRevisionDigest: localAuthoring.revisionDigest ?? null,
              remoteRevisionDigest: remoteHeadId,
              localAuthoringStateId: localAuthoring.authoringStateId ?? null,
              remoteAuthoringStateId: null,
              relation: authoredRelation,
              pendingSync: pendingSync ?? null,
            },
            compile: {
              relation: compileRelation,
              latestAttempt: localCompile.latestAttempt ?? null,
              latestSuccessful: localCompile.latestSuccessful ?? null,
            },
            authenticated: hasAuth,
            localDiff: {
              modified: diff.modified.length,
              added: diff.added.length,
              deleted: diff.deleted.length,
            },
            localDiffPaths: diff,
            verification: {
              verified,
              verifiedAt,
            },
          },
          null,
          2,
        ),
      );
      return;
    }

    consola.info(
      `Local changes: ${diff.modified.length} modified, ${diff.added.length} added, ${diff.deleted.length} deleted`,
    );
    if (diff.modified.length > 0)
      consola.log(`Modified: ${diff.modified.join(", ")}`);
    if (diff.added.length > 0) consola.log(`Added: ${diff.added.join(", ")}`);
    if (diff.deleted.length > 0)
      consola.log(`Deleted: ${diff.deleted.join(", ")}`);

    if (verified !== null) {
      consola.info(
        `Verification: ${verified ? "verified" : "unverified"}${verifiedAt ? ` at ${verifiedAt}` : ""}`,
      );
    }

    if (!hasAuth) {
      consola.warn("Remote status unavailable (no auth token).");
      return;
    }

    consola.info(
      `Project revision: ${authoredRelation} (local=${localAuthoring.revisionDigest ?? "unknown"}, remote=${remoteHeadId ?? "none"})`,
    );
    if (pendingSync) {
      consola.warn(
        `Previous sync is still being finalized (${pendingSync.phase}). Run 'dreamboard sync' again to finish updating local scaffold files.`,
      );
    }
    consola.info(`Compile state: ${compileRelation}`);
    if (compileRelation === "failed") {
      consola.warn(
        "Latest compile for the current authored state failed. Fix diagnostics and run 'dreamboard compile' again.",
      );
    }
    if (authoredRelation === "behind" || authoredRelation === "diverged") {
      consola.warn(
        "Remote authored changes are available. Run 'dreamboard pull' to reconcile them into this workspace.",
      );
    }
  },
});
