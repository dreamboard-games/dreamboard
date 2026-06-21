export type Environment = "local" | "staging" | "prod";

export type EnvironmentConfig = {
  apiBaseUrl: string;
  webBaseUrl: string;
  clerkOAuthIssuer?: string;
  clerkOAuthClientId?: string;
  clerkOAuthTokenUrl?: string;
  clerkOAuthScope?: string;
};

export type CredentialBackendPreference = "file" | "keychain";

export type GlobalConfig = {
  environment?: Environment;
  credentialBackend?: CredentialBackendPreference;
};

export type LocalMaintainerSdkPackageName =
  | "@dreamboard-games/api-client"
  | "@dreamboard-games/sdk";

export type LocalMaintainerRegistryPackages = {
  "@dreamboard-games/api-client"?: string;
  "@dreamboard-games/sdk": string;
};

export type LocalMaintainerRegistryConfig = {
  registryUrl: string;
  snapshotId: string;
  fingerprint: string;
  publishedAt: string;
  packages: LocalMaintainerRegistryPackages;
};

export type ProjectPendingSyncPhase =
  | "source_revision_created"
  | "authoring_state_created";

export type ProjectPendingAuthoringSync = {
  phase: ProjectPendingSyncPhase;
  revisionDigest?: string;
  authoringStateId?: string;
  ruleId?: string;
  manifestId?: string;
  manifestContentHash?: string;
  localManifestContentHash?: string;
  sourceRevisionId: string;
  sourceTreeHash: string;
};

export type ProjectAuthoringState = {
  revisionDigest?: string;
  authoringStateId?: string;
  ruleId?: string;
  manifestId?: string;
  manifestContentHash?: string;
  localManifestContentHash?: string;
  sourceRevisionId?: string;
  sourceTreeHash?: string;
  pendingSync?: ProjectPendingAuthoringSync;
};

export type ProjectCompileAttempt = {
  resultId?: string;
  jobId?: string;
  revisionDigest?: string;
  authoringStateId: string;
  status: "successful" | "failed";
  diagnosticsSummary?: string;
};

export type ProjectCompileState = {
  latestAttempt?: ProjectCompileAttempt;
  latestSuccessful?: {
    resultId: string;
    authoringStateId: string;
    revisionDigest?: string;
  };
};

export type ProjectManifestV2 = {
  schemaVersion: 2;
  projectId: string;
  slug: string;
};

export type ProjectEnvironmentBindingV1 = {
  deploymentId: string;
  ownerScopeId: string;
  remoteHeadDigest?: string;
  jobId?: string;
  agentManaged?: boolean;
  workspacePrepared?: boolean;
  allowCreateGame?: boolean;
  environment?: Environment;
  authoring?: ProjectAuthoringState;
  compile?: ProjectCompileState;
  localMaintainerRegistry?: LocalMaintainerRegistryConfig;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  packageManifest?: Record<string, unknown>;
  environmentManifest?: Record<string, unknown>;
};

export type ProjectEnvironmentStateV1 = {
  schemaVersion: 1;
  bindings: Record<string, ProjectEnvironmentBindingV1>;
};

export type ProjectConfig = ProjectManifestV2 &
  ProjectEnvironmentBindingV1 & {
    bindingKey?: string;
  };

export type Snapshot = {
  files: Record<string, string>;
  manifestHash?: string;
  resultId?: string;
};

export type LocalDiff = {
  modified: string[];
  added: string[];
  deleted: string[];
};

export type ResolvedConfig = {
  readonly environment: Environment;
  readonly apiBaseUrl: string;
  readonly webBaseUrl: string;
  readonly authToken?: string;
  readonly refreshToken?: string;
  readonly tokenExpiresAt?: string;
  readonly clerkAccessToken?: string;
  readonly clerkAccessExpiresAt?: string;
  readonly dreamboardApiToken?: string;
  readonly dreamboardApiExpiresAt?: string;
  readonly clerkOAuthIssuer?: string;
  readonly clerkOAuthClientId?: string;
  readonly clerkOAuthTokenUrl?: string;
  readonly clerkOAuthScope?: string;
  readonly authTokenSource: "global" | "env" | "agent-env" | "flag" | "none";
  readonly refreshTokenSource: "global" | "env" | "none";
};

export type ApiError = {
  message?: string;
  errors?: Record<string, string[]>;
};

export type UiStep = {
  playerId: string;
  buttons?: string[];
  turns?: number;
  mouse_x?: number;
  mouse_y?: number;
};

export type ApiScenarioStep = {
  playerId: string;
  actionType: string;
  parameters?: Record<string, unknown>;
  turns?: number;
};

export type TurnTracker = {
  waitForTurns: (turns: number) => Promise<void>;
  close: () => void;
};

export type RenderState = {
  buffers: Map<string, string>;
  opened: Set<string>;
};
