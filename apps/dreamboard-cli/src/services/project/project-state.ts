import type {
  ProjectAuthoringState,
  ProjectCompileAttempt,
  ProjectCompileState,
  ProjectConfig,
  ProjectPendingAuthoringSync,
} from "../../types.js";

export function getProjectAuthoringState(
  projectConfig: ProjectConfig,
): ProjectAuthoringState {
  return projectConfig.authoring ?? {};
}

export function getProjectPendingAuthoringSync(
  projectConfig: ProjectConfig,
): ProjectPendingAuthoringSync | undefined {
  return getProjectAuthoringState(projectConfig).pendingSync;
}

export function getProjectCompileState(
  projectConfig: ProjectConfig,
): ProjectCompileState {
  return projectConfig.compile ?? {};
}

export function updateProjectAuthoringState(
  projectConfig: ProjectConfig,
  authoring: ProjectAuthoringState,
): ProjectConfig {
  return {
    ...projectConfig,
    authoring: {
      ...getProjectAuthoringState(projectConfig),
      ...authoring,
    },
  };
}

export function setProjectPendingAuthoringSync(
  projectConfig: ProjectConfig,
  pendingSync: ProjectPendingAuthoringSync,
): ProjectConfig {
  return updateProjectAuthoringState(projectConfig, {
    pendingSync,
  });
}

export function clearProjectPendingAuthoringSync(
  projectConfig: ProjectConfig,
): ProjectConfig {
  const authoring = getProjectAuthoringState(projectConfig);
  if (!authoring.pendingSync) {
    return projectConfig;
  }

  const { pendingSync: _pendingSync, ...rest } = authoring;
  return {
    ...projectConfig,
    authoring: rest,
  };
}

export function finalizeProjectPendingAuthoringSync(
  projectConfig: ProjectConfig,
): ProjectConfig {
  const authoring = getProjectAuthoringState(projectConfig);
  const pendingSync = authoring.pendingSync;
  if (!pendingSync) {
    return projectConfig;
  }

  return updateProjectAuthoringState(
    clearProjectPendingAuthoringSync(projectConfig),
    {
      gameRevisionId:
        pendingSync.phase === "game_revision_created"
          ? pendingSync.gameRevisionId
          : authoring.gameRevisionId,
      revisionDigest: pendingSync.revisionDigest ?? authoring.revisionDigest,
      sourceRevisionId: pendingSync.sourceRevisionId,
      sourceTreeHash: pendingSync.sourceTreeHash,
      manifestContentHash: pendingSync.manifestContentHash,
      localManifestContentHash: pendingSync.localManifestContentHash,
    },
  );
}

export function updateProjectCompileState(
  projectConfig: ProjectConfig,
  compile: ProjectCompileState,
): ProjectConfig {
  return {
    ...projectConfig,
    compile: {
      ...getProjectCompileState(projectConfig),
      ...compile,
    },
  };
}

export function setLatestCompileAttempt(
  projectConfig: ProjectConfig,
  attempt: ProjectCompileAttempt,
): ProjectConfig {
  return updateProjectCompileState(projectConfig, {
    ...getProjectCompileState(projectConfig),
    latestAttempt: attempt,
    latestSuccessful:
      attempt.status === "successful" && attempt.resultId
        ? {
            resultId: attempt.resultId,
            revisionDigest: attempt.revisionDigest,
            gameRevisionId: attempt.gameRevisionId,
            sourceRevisionId: attempt.sourceRevisionId,
            sourceTreeHash: attempt.sourceTreeHash,
          }
        : getProjectCompileState(projectConfig).latestSuccessful,
  });
}

export function clearProjectCompileState(
  projectConfig: ProjectConfig,
): ProjectConfig {
  return {
    ...projectConfig,
    compile: {},
  };
}
