import { client } from "@dreamboard-games/api-client/client.gen";
import type {
  Environment,
  GlobalConfig,
  ProjectConfig,
  ResolvedConfig,
} from "../types.js";
import type { ConfigFlags } from "../flags.js";
import { IS_PUBLISHED_BUILD, PUBLISHED_ENVIRONMENT } from "../build-target.js";
import {
  DEFAULT_API_BASE_URL,
  DEFAULT_WEB_BASE_URL,
  ENVIRONMENT_CONFIGS,
} from "../constants.js";
import { loadGlobalConfig } from "./global-config.js";
import { findProjectRoot, loadProjectConfig } from "./project-config.js";
import {
  type Credentials,
  type StoredSessionSnapshot,
  getStoredSession,
  setCredentials,
} from "./credential-store.js";
import { classifyRefreshError } from "../auth/refresh-error.js";
import { refreshClerkOAuthToken } from "../auth/clerk-oauth.js";
import { resolveLocalHarnessAccessToken } from "./local-harness-auth.js";

const LOGIN_HINT = "Run `dreamboard login` to authenticate again.";
const DEFAULT_REFRESH_WINDOW_MS = 5 * 60 * 1000;
const TRANSIENT_READ_RETRY_DELAYS_MS = [100, 300];

export type CredentialSnapshot = {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  clerkOAuthIssuer?: string;
  clerkOAuthClientId?: string;
  clerkOAuthTokenUrl?: string;
  environment?: string;
  authTokenSource: ResolvedConfig["authTokenSource"];
  refreshTokenSource: ResolvedConfig["refreshTokenSource"];
};

/**
 * Resolve the effective CLI config for this invocation.
 *
 * `resolveConfig` is pure and synchronous: it takes pre-loaded inputs
 * (global config, flags, optional project config, optional credential
 * snapshot) and assembles a read-only `ResolvedConfig`. It intentionally
 * does not touch disk or the network - refreshing/persisting credentials
 * is the job of `configureClient` + `RefreshCoordinator`.
 *
 * Passing `credentials = undefined` is equivalent to "no stored session
 * for this call", used by contexts that should never inherit the local
 * session (e.g. `dreamboard login` before the browser flow).
 */
export function resolveConfig(
  globalConfig: GlobalConfig,
  flags: ConfigFlags,
  project?: ProjectConfig,
  credentials?: StoredSessionSnapshot | null,
): ResolvedConfig {
  if (IS_PUBLISHED_BUILD) {
    assertPublicRuntimeFlags(flags);
  }

  const envEnvironment = IS_PUBLISHED_BUILD
    ? undefined
    : environmentFromProcess();
  const projectEnvironment = IS_PUBLISHED_BUILD
    ? undefined
    : project?.environment;
  const environment = IS_PUBLISHED_BUILD
    ? PUBLISHED_ENVIRONMENT
    : flags.env ||
      envEnvironment ||
      projectEnvironment ||
      globalConfig.environment ||
      "staging";
  const envConfig = ENVIRONMENT_CONFIGS[environment];
  const publishedEnvConfig = ENVIRONMENT_CONFIGS[PUBLISHED_ENVIRONMENT];
  const hasExplicitEnvironmentOverride =
    !IS_PUBLISHED_BUILD &&
    Boolean(flags.env || envEnvironment || projectEnvironment);

  const resolvedApiBaseUrl = IS_PUBLISHED_BUILD
    ? (publishedEnvConfig?.apiBaseUrl ?? DEFAULT_API_BASE_URL)
    : hasExplicitEnvironmentOverride
      ? projectLocalBaseUrl(project?.apiBaseUrl, environment) ||
        envConfig?.apiBaseUrl ||
        DEFAULT_API_BASE_URL
      : project?.apiBaseUrl || envConfig?.apiBaseUrl || DEFAULT_API_BASE_URL;
  const apiBaseUrl =
    valueOrUndefined(process.env.DREAMBOARD_API_BASE_URL) ?? resolvedApiBaseUrl;

  const resolvedWebBaseUrl = IS_PUBLISHED_BUILD
    ? (publishedEnvConfig?.webBaseUrl ?? DEFAULT_WEB_BASE_URL)
    : hasExplicitEnvironmentOverride
      ? projectLocalBaseUrl(project?.webBaseUrl, environment) ||
        envConfig?.webBaseUrl ||
        DEFAULT_WEB_BASE_URL
      : project?.webBaseUrl || envConfig?.webBaseUrl || DEFAULT_WEB_BASE_URL;
  const webBaseUrl =
    valueOrUndefined(process.env.DREAMBOARD_WEB_BASE_URL) ?? resolvedWebBaseUrl;

  const snapshot = buildCredentialSnapshot(flags, credentials, environment);

  return {
    environment,
    apiBaseUrl,
    webBaseUrl,
    authToken: snapshot.accessToken,
    refreshToken: snapshot.refreshToken,
    tokenExpiresAt: snapshot.tokenExpiresAt,
    clerkOAuthIssuer: snapshot.clerkOAuthIssuer ?? envConfig?.clerkOAuthIssuer,
    clerkOAuthClientId:
      snapshot.clerkOAuthClientId ?? envConfig?.clerkOAuthClientId,
    clerkOAuthTokenUrl:
      snapshot.clerkOAuthTokenUrl ??
      valueOrUndefined(process.env.DREAMBOARD_CLERK_OAUTH_TOKEN_URL),
    clerkOAuthScope: envConfig?.clerkOAuthScope,
    authTokenSource: snapshot.authTokenSource,
    refreshTokenSource: snapshot.refreshTokenSource,
  };
}

function buildCredentialSnapshot(
  flags: ConfigFlags,
  storedCredentials?: StoredSessionSnapshot | null,
  environment?: Environment,
): CredentialSnapshot {
  const flagToken = valueOrUndefined(flags.token);
  const agentEnvToken = valueOrUndefined(process.env.DREAMBOARD_AGENT_TOKEN);
  const envToken = valueOrUndefined(process.env.DREAMBOARD_TOKEN);
  const environmentScopedStoredCredentials =
    storedCredentials?.environment &&
    environment &&
    storedCredentials.environment !== environment
      ? null
      : (storedCredentials ?? null);

  if (IS_PUBLISHED_BUILD) {
    const stored = environmentScopedStoredCredentials;
    if (agentEnvToken) {
      return {
        accessToken: agentEnvToken,
        refreshToken: undefined,
        tokenExpiresAt: undefined,
        authTokenSource: "agent-env",
        refreshTokenSource: "none",
      };
    }
    return {
      accessToken: stored?.accessToken,
      refreshToken: stored?.refreshToken,
      tokenExpiresAt: stored?.tokenExpiresAt,
      clerkOAuthIssuer: stored?.clerkOAuthIssuer,
      clerkOAuthClientId: stored?.clerkOAuthClientId,
      clerkOAuthTokenUrl: stored?.clerkOAuthTokenUrl,
      environment: stored?.environment,
      authTokenSource: stored?.accessToken ? "global" : "none",
      refreshTokenSource: stored?.refreshToken ? "global" : "none",
    };
  }

  const accessToken =
    flagToken ||
    agentEnvToken ||
    envToken ||
    environmentScopedStoredCredentials?.accessToken;
  const refreshToken = environmentScopedStoredCredentials?.refreshToken;

  const authTokenSource: ResolvedConfig["authTokenSource"] = flagToken
    ? "flag"
    : agentEnvToken
      ? "agent-env"
      : envToken
        ? "env"
        : environmentScopedStoredCredentials?.accessToken
          ? "global"
          : "none";

  const refreshTokenSource: ResolvedConfig["refreshTokenSource"] =
    environmentScopedStoredCredentials?.refreshToken ? "global" : "none";

  return {
    accessToken,
    refreshToken,
    tokenExpiresAt: environmentScopedStoredCredentials?.tokenExpiresAt,
    clerkOAuthIssuer: environmentScopedStoredCredentials?.clerkOAuthIssuer,
    clerkOAuthClientId: environmentScopedStoredCredentials?.clerkOAuthClientId,
    clerkOAuthTokenUrl: environmentScopedStoredCredentials?.clerkOAuthTokenUrl,
    environment: environmentScopedStoredCredentials?.environment,
    authTokenSource,
    refreshTokenSource,
  };
}

function environmentFromProcess(): Environment | undefined {
  const value = valueOrUndefined(process.env.DREAMBOARD_ENV);
  if (!value) return undefined;
  if (value === "local" || value === "staging" || value === "prod") {
    return value;
  }
  throw new Error(
    `Invalid DREAMBOARD_ENV '${value}'. Valid options: local, staging, prod`,
  );
}

function projectLocalBaseUrl(
  rawUrl: string | undefined,
  environment: Environment,
): string | undefined {
  if (environment !== "local" || !rawUrl) return undefined;
  try {
    const url = new URL(rawUrl);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1"
      ? rawUrl
      : undefined;
  } catch {
    return undefined;
  }
}

function assertPublicRuntimeFlags(flags: ConfigFlags): void {
  const argv = process.argv.slice(2);

  if (flags.env || argv.includes("--env")) {
    throw new Error(
      "The published Dreamboard CLI is production-only and does not accept `--env`.",
    );
  }

  if (valueOrUndefined(flags.token) || argv.includes("--token")) {
    throw new Error(
      "Direct JWT injection is not supported in the published Dreamboard CLI. Use `dreamboard login` so the CLI can store and refresh your session.",
    );
  }

  if (process.env.DREAMBOARD_TOKEN) {
    throw new Error(
      "The published Dreamboard CLI ignores direct token environment variables. Use `dreamboard login` so the CLI can manage refreshable credentials.",
    );
  }
}

/**
 * Configure the API client for the resolved environment, refreshing the
 * stored CLI session first if it is close to expiry.
 *
 * The refresh path never mutates `config`. It goes through
 * Clerk OAuth directly and the CredentialStore writes. After a successful
 * rotation the HTTP client
 * is configured with the rotated access token; on transient failures we
 * fall back to the `config.authToken` snapshot (which is why commands
 * still see a bearer header and can surface the original error).
 */
export async function configureClient(config: ResolvedConfig): Promise<void> {
  const effectiveAccessToken = await ensureEffectiveAccessToken(config);

  client.setConfig({
    baseUrl: config.apiBaseUrl,
    fetch: createRetryingReadFetch(globalThis.fetch.bind(globalThis)),
    headers: effectiveAccessToken
      ? { Authorization: `Bearer ${effectiveAccessToken}` }
      : {},
  });
}

function createRetryingReadFetch(fetchImpl: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = resolveFetchMethod(input, init);
    if (method !== "GET" && method !== "HEAD") {
      return fetchImpl(input, init);
    }

    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= TRANSIENT_READ_RETRY_DELAYS_MS.length;
      attempt += 1
    ) {
      try {
        return await fetchImpl(input, init);
      } catch (error) {
        lastError = error;
        if (
          attempt >= TRANSIENT_READ_RETRY_DELAYS_MS.length ||
          !isTransientFetchError(error)
        ) {
          throw error;
        }
        await sleep(TRANSIENT_READ_RETRY_DELAYS_MS[attempt]!);
      }
    }

    throw lastError;
  }) as typeof fetch;
}

function resolveFetchMethod(
  input: RequestInfo | URL,
  init?: RequestInit,
): string {
  const method =
    init?.method ??
    (typeof Request !== "undefined" && input instanceof Request
      ? input.method
      : undefined);
  return (method ?? "GET").toUpperCase();
}

function isTransientFetchError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message)
        : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("fetch failed") ||
    normalized.includes("network") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("econnrefused") ||
    normalized.includes("socket")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureEffectiveAccessToken(
  config: ResolvedConfig,
): Promise<string | undefined> {
  const localHarnessToken = resolveLocalHarnessAccessToken(config);
  if (localHarnessToken) return localHarnessToken;

  if (!usesStoredSession(config)) {
    // Env/flag-provided tokens are not owned by CredentialStore and must
    // not be written back. Use them as-is.
    return config.authToken;
  }

  if (config.refreshToken) {
    const credentials = await refreshClerkOAuthSessionIfNeeded(config);
    return credentials?.accessToken ?? config.authToken;
  }

  return config.authToken;
}

/**
 * Explicit "force a refresh attempt right now" entrypoint used by
 * `dreamboard auth status`. Returns the resulting credentials or throws
 * a classified error.
 */
export async function refreshResolvedAuthSession(
  config: ResolvedConfig,
): Promise<Credentials | null> {
  if (!usesStoredSession(config)) return null;
  if (config.refreshToken) {
    return refreshClerkOAuthSession(config);
  }
  return null;
}

async function refreshClerkOAuthSessionIfNeeded(
  config: ResolvedConfig,
): Promise<Credentials | null> {
  const expiry = config.tokenExpiresAt
    ? new Date(config.tokenExpiresAt)
    : getAuthTokenExpiry(config.authToken);
  if (expiry && expiry.getTime() > Date.now() + DEFAULT_REFRESH_WINDOW_MS) {
    if (!config.authToken || !config.refreshToken) return null;
    return {
      accessToken: config.authToken,
      refreshToken: config.refreshToken,
      tokenExpiresAt: config.tokenExpiresAt,
      clerkOAuthIssuer: config.clerkOAuthIssuer,
      clerkOAuthClientId: config.clerkOAuthClientId,
      clerkOAuthTokenUrl: config.clerkOAuthTokenUrl,
      environment: config.environment,
    };
  }
  return refreshClerkOAuthSession(config);
}

async function refreshClerkOAuthSession(
  config: ResolvedConfig,
): Promise<Credentials | null> {
  if (!config.refreshToken) return null;
  const payload = await refreshClerkOAuthToken({
    config: {
      issuer: config.clerkOAuthIssuer,
      clientId: config.clerkOAuthClientId,
      tokenUrl: config.clerkOAuthTokenUrl,
    },
    refreshToken: config.refreshToken,
  });
  const credentials = {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    tokenExpiresAt: payload.expiresAt,
    clerkOAuthIssuer: config.clerkOAuthIssuer,
    clerkOAuthClientId: config.clerkOAuthClientId,
    clerkOAuthTokenUrl: payload.tokenUrl,
    environment: config.environment,
  };
  await setCredentials(credentials);
  return credentials;
}

export function requireAuth(config: ResolvedConfig): void {
  if (!config.authToken && !resolveLocalHarnessAccessToken(config)) {
    throw new Error(
      "Missing Dreamboard session. Run `dreamboard login` to authenticate.",
    );
  }
}

export function valueOrUndefined(
  value: string | boolean | undefined,
): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function getAuthTokenExpiry(
  accessToken: string | undefined,
): Date | null {
  if (!accessToken) return null;
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
      return null;
    }
    return new Date(payload.exp * 1000);
  } catch {
    return null;
  }
}

/**
 * Compatibility helper retained for `dreamboard auth status` / tests.
 * Returns true iff the error looks like a permanent refresh-token
 * invalidation. Prefer `classifyRefreshError` for new call sites.
 */
export function isInvalidRefreshTokenMessage(
  message: string | undefined,
): boolean {
  if (!message) return false;
  return classifyRefreshError({ message }).kind === "permanent_invalid";
}

export function formatStoredSessionInvalidMessage(reason?: string): string {
  const detail = reason ? ` (${reason})` : "";
  return `Stored Dreamboard session is expired or invalid${detail}. ${LOGIN_HINT}`;
}

function usesStoredSession(config: ResolvedConfig): boolean {
  return (
    config.authTokenSource === "global" &&
    config.refreshTokenSource === "global"
  );
}

/**
 * Common init pattern used by pull, push, status, update, run commands:
 * find project root, load config, resolve config, require auth,
 * configure client.
 */
export async function resolveProjectContext(
  flags: ConfigFlags,
  opts?: { requireAuth?: boolean },
): Promise<{
  projectRoot: string;
  projectConfig: ProjectConfig;
  config: ResolvedConfig;
}> {
  const projectRoot = await findProjectRoot(process.cwd());
  if (!projectRoot) {
    throw new Error(
      "Not inside a dreamboard project (missing .dreamboard/project.json).",
    );
  }

  const projectConfig = await loadProjectConfig(projectRoot);
  const [globalConfig, credentials] = await Promise.all([
    loadGlobalConfig(),
    getStoredSession(),
  ]);
  const config = resolveConfig(globalConfig, flags, projectConfig, credentials);

  if (opts?.requireAuth !== false) {
    requireAuth(config);
    await configureClient(config);
  }

  return { projectRoot, projectConfig, config };
}
