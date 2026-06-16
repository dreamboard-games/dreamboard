import consola from "consola";
import type { CompiledResult } from "@dreamboard-games/api-client";
import type { ProjectConfig } from "../../types.js";
import {
  findProjectCompiledResultsForRevision,
  getProjectCompiledResultSdk,
} from "../api/compiled-results-api.js";
import {
  getProjectCompileState,
  getProjectAuthoringState,
  getProjectPendingAuthoringSync,
} from "../project/project-state.js";

export async function resolveLatestCompiledResult(
  projectRoot: string,
  projectConfig: ProjectConfig,
): Promise<CompiledResult> {
  void projectRoot;
  const authoring = getProjectAuthoringState(projectConfig);
  if (getProjectPendingAuthoringSync(projectConfig)) {
    throw new Error(
      "Previous sync did not finish updating local scaffold files. Run 'dreamboard sync' again first.",
    );
  }
  if (authoring.revisionDigest) {
    const compile = getProjectCompileState(projectConfig);
    const latestSuccess = (
      await findProjectCompiledResultsForRevision({
        projectId: projectConfig.projectId,
        revisionDigest: authoring.revisionDigest,
      })
    ).find((result) => result.success);
    const matchingLocalSuccess =
      compile.latestSuccessful?.revisionDigest === authoring.revisionDigest
        ? compile.latestSuccessful
        : undefined;
    const resolvedSuccess =
      latestSuccess ??
      (matchingLocalSuccess?.resultId
        ? await getProjectCompiledResultSdk(
            projectConfig.projectId,
            matchingLocalSuccess.resultId,
          )
        : undefined);

    if (!resolvedSuccess?.success) {
      throw new Error(
        "No successful compile exists for the current authored revision. Run 'dreamboard compile' first.",
      );
    }

    const resultRevisionDigest = (resolvedSuccess as { revisionDigest?: string })
      .revisionDigest;
    if (
      resultRevisionDigest &&
      resultRevisionDigest !== authoring.revisionDigest
    ) {
      consola.warn(
        `Latest successful compile ${resolvedSuccess.id} belongs to ${resultRevisionDigest}, not ${authoring.revisionDigest}.`,
      );
    }

    consola.info(
      `Project summary:\n  compiledResultId: ${resolvedSuccess.id}\n  revisionDigest: ${authoring.revisionDigest}`,
    );

    return resolvedSuccess;
  }

  throw new Error(
    "This workspace does not know its project revision yet. Run 'dreamboard sync' first.",
  );
}
