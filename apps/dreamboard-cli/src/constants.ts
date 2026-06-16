import type { EnvironmentConfig } from "./types.js";

export const DEFAULT_API_BASE_URL = "https://api.dreamboard.games";
export const DEFAULT_WEB_BASE_URL = "https://dreamboard.games";

export const PROJECT_DIR_NAME = ".dreamboard";
export const DEFAULT_CLERK_OAUTH_SCOPE =
  "openid profile email offline_access";

// Predefined environment configurations. These are intentionally static:
// process/env overrides are applied in config resolution so the CLI does not
// depend on a shell-sourced env file just to know first-party environments.
export const ENVIRONMENT_CONFIGS: Record<string, EnvironmentConfig> = {
  local: {
    apiBaseUrl: "http://localhost:8080",
    webBaseUrl: "http://localhost:5173",
    clerkOAuthScope: DEFAULT_CLERK_OAUTH_SCOPE,
  },
  staging: {
    apiBaseUrl: "https://api-staging.dreamboard.games",
    webBaseUrl: "https://staging.dreamboard.games",
    clerkOAuthIssuer: "https://happy-caribou-19.clerk.accounts.dev",
    clerkOAuthTokenUrl:
      "https://happy-caribou-19.clerk.accounts.dev/oauth/token",
    clerkOAuthScope: DEFAULT_CLERK_OAUTH_SCOPE,
  },
  prod: {
    apiBaseUrl: "https://api.dreamboard.games",
    webBaseUrl: "https://dreamboard.games",
    clerkOAuthScope: DEFAULT_CLERK_OAUTH_SCOPE,
  },
};
export const PROJECT_CONFIG_FILE = "project.json";
export const PROJECT_STATE_FILE = "state.json";
export const SNAPSHOT_FILE = "snapshot.json";
export const MANIFEST_FILE = "manifest.ts";
export const GENERATED_DIR_NAME = "generated";
export const MATERIALIZED_MANIFEST_FILE = `${PROJECT_DIR_NAME}/${GENERATED_DIR_NAME}/manifest.json`;
export const MANIFEST_TYPECHECK_CONFIG_FILE = "manifest.tsconfig.json";
export const RULE_FILE = "rule.md";
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
export const DEFAULT_TURN_DELAY_MS = 250;

export const LOCAL_IGNORE_DIRS = new Set([
  ".dreamboard",
  ".git",
  "node_modules",
  "dist",
]);
