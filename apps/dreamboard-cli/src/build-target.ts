declare const __DREAMBOARD_BUILD_CHANNEL__: string | undefined;
declare const __DREAMBOARD_PACKAGE_VERSION__: string | undefined;

const injectedBuildChannel =
  typeof __DREAMBOARD_BUILD_CHANNEL__ === "string"
    ? __DREAMBOARD_BUILD_CHANNEL__
    : undefined;
const injectedPackageVersion =
  typeof __DREAMBOARD_PACKAGE_VERSION__ === "string"
    ? __DREAMBOARD_PACKAGE_VERSION__
    : undefined;

export const BUILD_CHANNEL =
  injectedBuildChannel === "published" ? "published" : "development";
export const PACKAGE_VERSION = injectedPackageVersion ?? "0.0.0-development";

export function isAlphaReleaseVersion(version: string): boolean {
  return /(?:^|-|\.)alpha(?:$|-|\.)/.test(version);
}

export const IS_PUBLISHED_BUILD = BUILD_CHANNEL === "published";
export const IS_ALPHA_RELEASE = isAlphaReleaseVersion(PACKAGE_VERSION);
export const CAN_SELECT_ENVIRONMENT =
  !IS_PUBLISHED_BUILD || IS_ALPHA_RELEASE;
export const PUBLISHED_ENVIRONMENT = "prod" as const;
