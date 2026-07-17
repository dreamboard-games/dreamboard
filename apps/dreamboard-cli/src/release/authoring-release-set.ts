export type AuthoringReleasePackageV1 = {
  name: string;
  version: string;
};

export type AuthoringReleaseCandidateV1 = AuthoringReleasePackageV1 & {
  receiptPath: string;
  packageIntegrity?: string;
  tarballSha512?: string;
};

export type AuthoringReleaseSetV1 = {
  schemaVersion: 1;
  releaseSetId: string;
  channel: "public";
  packages: {
    cli: AuthoringReleasePackageV1;
    sdk: AuthoringReleasePackageV1;
    apiClient: AuthoringReleasePackageV1;
    devHost: AuthoringReleasePackageV1;
  };
  protocols: {
    authoringAdapter: 1;
    devHost: 1;
    verifier: 1;
  };
  schemas: {
    scaffold: 2;
    manifest: 2;
    generatedArtifacts: 1;
  };
  registry: {
    kind: "public-npm";
    portable: true;
  };
  candidates?: Partial<
    Record<"sdk" | "apiClient" | "devHost", AuthoringReleaseCandidateV1>
  >;
  packageManager: string;
};

export { AUTHORING_RELEASE_SET } from "./authoring-release-set.generated.js";
