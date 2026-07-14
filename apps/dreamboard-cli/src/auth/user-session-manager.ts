import type {
  AccessToken,
  RefreshableUserSession,
  UserSessionManager,
  UserSessionStatus,
} from "@dreamboard-games/cli-core";
import {
  type CredentialLockOps,
  type Credentials,
  type StoredSessionSnapshot,
  withCredentialLock,
} from "../config/credential-store.js";
import type { ResolvedConfig } from "../types.js";
import { refreshClerkOAuthToken } from "./clerk-oauth.js";
import { classifyRefreshError } from "./refresh-error.js";
import {
  exchangeDreamboardUserToken,
  type DreamboardTokenAudience,
} from "./token-exchange.js";

const DEFAULT_TOKEN_MIN_VALIDITY_MS = 60 * 1000;

export function createUserSessionManager(
  config: ResolvedConfig,
): UserSessionManager {
  return {
    async establishRefreshableSession(session) {
      return withCredentialLock(async (ops) => {
        const credentials = credentialsFromRefreshableSession(session);

        // The Clerk refresh token is the durable session authority. Persist it
        // before exchanging derived audience tokens so a transient Dreamboard
        // API failure cannot discard a newly established login.
        await ops.writeFull(credentials);

        const exchanged = await exchangeDreamboardUserToken({
          apiBaseUrl: config.apiBaseUrl,
          clerkAccessToken: credentials.accessToken,
          audience: "dreamboard-api",
        });
        const apiToken = toAccessToken(exchanged);
        await ops.writeFull(withApiToken(credentials, apiToken));
        return apiToken;
      });
    },

    async establishAccessOnlySession(accessToken) {
      await withCredentialLock((ops) => ops.writeAccessOnly(accessToken));
    },

    async resolveApiToken(options) {
      const localOrInjected = resolveNonStoredToken(config, "dreamboard-api");
      if (localOrInjected) return localOrInjected;
      if (!usesStoredSession(config)) return null;

      const minValidityMs =
        options?.minValiditySeconds === undefined
          ? DEFAULT_TOKEN_MIN_VALIDITY_MS
          : Math.max(0, options.minValiditySeconds * 1000);

      return withCredentialLock(async (ops) => {
        const stored = await ops.read();
        return resolveStoredApiToken(ops, config, stored, minValidityMs);
      });
    },

    async resolveGitToken() {
      const localOrInjected = resolveNonStoredToken(config, "dreamboard-git");
      if (localOrInjected) return localOrInjected;
      if (!usesStoredSession(config)) {
        throw missingSessionError();
      }

      return withCredentialLock(async (ops) => {
        const stored = await ops.read();
        const clerk = await resolveFreshClerkSession(ops, config, stored);
        return toAccessToken(
          await exchangeDreamboardUserToken({
            apiBaseUrl: config.apiBaseUrl,
            clerkAccessToken: clerk.accessToken,
            audience: "dreamboard-git",
          }),
        );
      });
    },

    async inspectSession() {
      const localOrInjected = resolveNonStoredToken(config, "dreamboard-api");
      if (localOrInjected) {
        return inspectAccessOnlyToken(localOrInjected);
      }
      if (!usesStoredSession(config)) {
        return { kind: "none" };
      }

      return withCredentialLock(async (ops) => {
        const stored = await ops.read();
        if (!stored) return { kind: "none" };

        const cached = freshStoredApiToken(
          stored,
          DEFAULT_TOKEN_MIN_VALIDITY_MS,
        );
        if (cached) {
          return activeStatus("refreshable", cached, false);
        }

        try {
          const token = await resolveStoredApiToken(
            ops,
            config,
            stored,
            DEFAULT_TOKEN_MIN_VALIDITY_MS,
          );
          return activeStatus("refreshable", token, true);
        } catch (error) {
          return failedRefreshableStatus(error);
        }
      });
    },

    async logout() {
      await withCredentialLock((ops) => ops.clear("logout_command"));
    },
  };
}

async function resolveStoredApiToken(
  ops: CredentialLockOps,
  config: ResolvedConfig,
  stored: StoredSessionSnapshot | null,
  minValidityMs: number,
): Promise<AccessToken> {
  const cached = freshStoredApiToken(stored, minValidityMs);
  if (cached) return cached;

  const clerk = await resolveFreshClerkSession(ops, config, stored);
  const exchanged = await exchangeDreamboardUserToken({
    apiBaseUrl: config.apiBaseUrl,
    clerkAccessToken: clerk.accessToken,
    audience: "dreamboard-api",
  });
  const apiToken = toAccessToken(exchanged);
  await ops.writeFull(withApiToken(clerk, apiToken));
  return apiToken;
}

async function resolveFreshClerkSession(
  ops: CredentialLockOps,
  config: ResolvedConfig,
  stored: StoredSessionSnapshot | null,
): Promise<Credentials> {
  if (!stored) {
    throw missingSessionError();
  }
  if (!stored.refreshToken) {
    throw new Error(
      "Stored Dreamboard session is missing its refresh token. Run `dreamboard auth login` to authenticate again.",
    );
  }

  if (
    stored.accessToken &&
    isFresh(
      stored.tokenExpiresAt,
      stored.accessToken,
      DEFAULT_TOKEN_MIN_VALIDITY_MS,
    )
  ) {
    return credentialsFromStored(config, stored);
  }

  const payload = await refreshClerkOAuthToken({
    config: {
      issuer: stored.clerkOAuthIssuer ?? config.clerkOAuthIssuer,
      clientId: stored.clerkOAuthClientId ?? config.clerkOAuthClientId,
      tokenUrl: stored.clerkOAuthTokenUrl ?? config.clerkOAuthTokenUrl,
    },
    refreshToken: stored.refreshToken,
  });
  const refreshed: Credentials = {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    tokenExpiresAt: payload.expiresAt,
    dreamboardApiToken: stored.dreamboardApiToken,
    dreamboardApiExpiresAt: stored.dreamboardApiExpiresAt,
    clerkOAuthIssuer: stored.clerkOAuthIssuer ?? config.clerkOAuthIssuer,
    clerkOAuthClientId: stored.clerkOAuthClientId ?? config.clerkOAuthClientId,
    clerkOAuthTokenUrl: payload.tokenUrl,
    environment: stored.environment ?? config.environment,
  };

  // OAuth refresh tokens may rotate. Save the refreshed Clerk layer before
  // any audience exchange, while retaining derived token caches.
  await ops.writeFull(refreshed);
  return refreshed;
}

function credentialsFromStored(
  config: ResolvedConfig,
  stored: StoredSessionSnapshot,
): Credentials {
  if (!stored.accessToken || !stored.refreshToken) {
    throw missingSessionError();
  }
  return {
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    tokenExpiresAt: stored.tokenExpiresAt,
    dreamboardApiToken: stored.dreamboardApiToken,
    dreamboardApiExpiresAt: stored.dreamboardApiExpiresAt,
    clerkOAuthIssuer: stored.clerkOAuthIssuer ?? config.clerkOAuthIssuer,
    clerkOAuthClientId: stored.clerkOAuthClientId ?? config.clerkOAuthClientId,
    clerkOAuthTokenUrl: stored.clerkOAuthTokenUrl ?? config.clerkOAuthTokenUrl,
    environment: stored.environment ?? config.environment,
  };
}

function credentialsFromRefreshableSession(
  session: RefreshableUserSession,
): Credentials {
  return {
    accessToken: session.clerkAccessToken,
    refreshToken: session.refreshToken,
    tokenExpiresAt: session.clerkAccessExpiresAt,
    clerkOAuthIssuer: session.clerkOAuthIssuer,
    clerkOAuthClientId: session.clerkOAuthClientId,
    clerkOAuthTokenUrl: session.clerkOAuthTokenUrl,
    environment: session.environment,
  };
}

function withApiToken(
  credentials: Credentials,
  token: AccessToken,
): Credentials {
  return {
    ...credentials,
    dreamboardApiToken: token.token,
    dreamboardApiExpiresAt: token.expiresAt,
  };
}

function toAccessToken(token: {
  accessToken: string;
  expiresAt?: string;
  audience: DreamboardTokenAudience;
}): AccessToken {
  return {
    token: token.accessToken,
    expiresAt: token.expiresAt,
    audience: token.audience,
  };
}

function resolveNonStoredToken(
  config: ResolvedConfig,
  audience: DreamboardTokenAudience,
): AccessToken | null {
  if (usesStoredSession(config)) return null;
  if (!config.authToken) return null;
  return {
    token: config.authToken,
    expiresAt: config.tokenExpiresAt,
    audience,
  };
}

function freshStoredApiToken(
  stored: StoredSessionSnapshot | null,
  minValidityMs: number,
): AccessToken | null {
  if (!stored?.dreamboardApiToken) return null;
  if (
    isFresh(
      stored.dreamboardApiExpiresAt,
      stored.dreamboardApiToken,
      minValidityMs,
    )
  ) {
    return {
      token: stored.dreamboardApiToken,
      expiresAt: stored.dreamboardApiExpiresAt,
      audience: "dreamboard-api",
    };
  }
  return null;
}

function inspectAccessOnlyToken(token: AccessToken): UserSessionStatus {
  const expiry = resolveExpiry(token.expiresAt, token.token);
  if (expiry && expiry.getTime() <= Date.now()) {
    return {
      kind: "invalid",
      sessionKind: "access-only",
      message:
        "Stored Dreamboard access token is expired. Run `dreamboard auth login` to authenticate again.",
    };
  }
  return activeStatus("access-only", token, false);
}

function failedRefreshableStatus(error: unknown): UserSessionStatus {
  const message = error instanceof Error ? error.message : String(error);
  const errorStatus =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  const classification = classifyRefreshError({
    message,
    status: typeof errorStatus === "number" ? errorStatus : undefined,
  });
  if (classification.kind === "permanent_invalid") {
    return {
      kind: "invalid",
      sessionKind: "refreshable",
      message,
    };
  }
  return {
    kind: "degraded",
    sessionKind: "refreshable",
    message,
  };
}

function activeStatus(
  sessionKind: "access-only" | "refreshable",
  apiToken: AccessToken,
  repaired: boolean,
): UserSessionStatus {
  return {
    kind: "active",
    sessionKind,
    apiToken,
    repaired,
  };
}

function missingSessionError(): Error {
  return new Error(
    "Missing Dreamboard session. Run `dreamboard auth login` to authenticate.",
  );
}

function isFresh(
  expiresAt: string | undefined,
  token: string,
  minValidityMs: number,
): boolean {
  const expiry = resolveExpiry(expiresAt, token);
  return (
    expiry !== null &&
    Number.isFinite(expiry.getTime()) &&
    expiry.getTime() > Date.now() + minValidityMs
  );
}

function resolveExpiry(
  expiresAt: string | undefined,
  token: string,
): Date | null {
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }
  return getJwtExpiry(token);
}

function getJwtExpiry(accessToken: string | undefined): Date | null {
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

function usesStoredSession(config: ResolvedConfig): boolean {
  return config.refreshTokenSource === "global";
}
