export type ProjectAuthoringProblemCode =
  | "SDK_NOT_INSTALLED"
  | "AUTHORING_ADAPTER_NOT_EXPORTED"
  | "AUTHORING_PROTOCOL_UNSUPPORTED"
  | "SDK_METADATA_MISMATCH"
  | "GENERATED_PATH_CONTRACT_INVALID";

export class ProjectAuthoringError extends Error {
  readonly code: ProjectAuthoringProblemCode;

  constructor(code: ProjectAuthoringProblemCode, message: string) {
    super(message);
    this.name = "ProjectAuthoringError";
    this.code = code;
  }
}

export type GeneratedAuthoringMetadataV1 = {
  sdkVersion: string;
  codegenVersion: string;
  manifestSchemaVersion: number;
  generatedArtifactSchemaVersion: number;
};

export type AuthoringValidationResultV1 = {
  valid: boolean;
  errors: readonly string[];
  warnings: readonly string[];
};

export type GeneratedArtifactV1 = {
  path: string;
  ownership: "authoritative" | "seed";
  content: string;
  contentSha256: string;
};

export type GeneratedPathPatternV1 = {
  prefix: string;
  suffix: string;
};

export type AuthoringManifestConformanceCaseV1 = {
  id: string;
  manifest: unknown;
  expected:
    | {
        valid: true;
        transportValid: true;
        materializedSha256: string;
      }
    | {
        valid: false;
        transportValid: boolean;
        diagnosticCodes: readonly string[];
      };
};

export type ProjectAuthoringAdapterV1 = {
  protocolVersion: 1;
  metadata: GeneratedAuthoringMetadataV1;
  generatedPaths: readonly string[];
  generatedPathPatterns?: readonly GeneratedPathPatternV1[];
  manifestConformanceCases: readonly AuthoringManifestConformanceCaseV1[];
  validateManifest(manifest: unknown): AuthoringValidationResultV1;
  materializeManifest(manifest: unknown): unknown;
  generateWorkspaceArtifacts(manifest: unknown): readonly GeneratedArtifactV1[];
};

export type LoadedProjectAuthoringAdapterV1 = {
  packageRoot: string;
  packageVersion: string;
  adapterPath: string;
  adapter: ProjectAuthoringAdapterV1;
};
