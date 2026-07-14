import { IS_PUBLISHED_BUILD } from "../../build-target.js";

export function isRemoteTestEnvironment(
  environment: string | undefined,
): environment is "staging" | "prod" {
  return environment === "staging" || environment === "prod";
}

export function shouldUseRemoteTestRuntime(
  environment: string | undefined,
): boolean {
  return IS_PUBLISHED_BUILD || isRemoteTestEnvironment(environment);
}
