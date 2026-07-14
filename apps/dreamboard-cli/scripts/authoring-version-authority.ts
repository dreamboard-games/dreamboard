import type { AuthoringReleaseSetV1 } from "../src/release/authoring-release-set.ts";

export type AuthoringSourcePackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export type AuthoringSourcePackages = {
  cli: AuthoringSourcePackageJson;
  apiClient: AuthoringSourcePackageJson;
  devHost: AuthoringSourcePackageJson;
};

export function inspectAuthoringSourceVersionAuthority(
  releaseSet: AuthoringReleaseSetV1,
  packages: AuthoringSourcePackages,
): string[] {
  const failures: string[] = [];

  assertEqual(
    failures,
    "CLI source version",
    packages.cli.version,
    releaseSet.packages.cli.version,
  );
  assertEqual(
    failures,
    "API-client source version",
    packages.apiClient.version,
    releaseSet.packages.apiClient.version,
  );
  assertEqual(
    failures,
    "dev-host source version",
    packages.devHost.version,
    releaseSet.packages.devHost.version,
  );
  assertEqual(
    failures,
    "CLI SDK development dependency",
    packages.cli.devDependencies?.["@dreamboard-games/sdk"],
    releaseSet.packages.sdk.version,
  );
  assertEqual(
    failures,
    "dev-host SDK peer",
    packages.devHost.peerDependencies?.["@dreamboard-games/sdk"],
    releaseSet.packages.sdk.version,
  );

  const devHostSdkDependency =
    packages.devHost.dependencies?.["@dreamboard-games/sdk"];
  if (devHostSdkDependency !== undefined) {
    assertEqual(
      failures,
      "dev-host SDK source dependency",
      devHostSdkDependency,
      releaseSet.packages.sdk.version,
    );
  }

  return failures;
}

function assertEqual(
  failures: string[],
  label: string,
  actual: string | undefined,
  expected: string,
): void {
  if (actual !== expected) {
    failures.push(
      `${label} is ${actual ?? "missing"}; expected ${expected} from the release set`,
    );
  }
}
