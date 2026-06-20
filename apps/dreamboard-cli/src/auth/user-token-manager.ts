import type {
  Credentials,
  StoredSessionSnapshot,
} from "../config/credential-store.js";
import {
  clearCredentials,
  withCredentialLock,
} from "../config/credential-store.js";
import type {
  AccessToken,
  UserTokenManager,
} from "@dreamboard-games/cli-core";
import { refreshClerkOAuthToken } from "./clerk-oauth.js";
import {
  exchangeDreamboardUserToken,
  type DreamboardTokenAudience,
} from "./token-exchange.js";
import type { ResolvedConfig } from "../types.js";

const TOKEN_REFRESH_WINDOW_MS = 60 * 1000;

export function createUserTokenManager(
  config: ResolvedConfig,
): UserTokenManager {
  return {
    async resolveApiToken() {
      const localOrInjected = resolveNonStoredToken(config, "dreamboard-api");
      if (localOrInjected) return localOrInjected;

      if (!usesStoredSession(config)) return null;

      return withCredentialLock(async (ops) => {
        const stored = await ops.read();
        const apiToken = freshStoredApiToken(stored);
        if (apiToken) return apiToken;

        const clerk = await resolveFreshClerkAccessToken(config, stored);
        const exchanged = await exchangeDreamboardUserToken({
          apiBaseUrl: config.apiBaseUrl,
          clerkAccessToken: clerk.accessToken,
          audience: "dreamboard-api",
        });

        await ops.writeFull({
          ...clerk,
          dreamboardApiToken: exchanged.accessToken,
          dreamboardApiExpiresAt: exchanged.expiresAt,
        });

        return {
          token: exchanged.accessToken,
          expiresAt: exchanged.expiresAt,
          audience: "dreamboard-api",
        };
      });
    },

    async resolveGitToken() {
      if (!usesStoredSession(config) && config.authToken) {
        const exchanged = await exchangeDreamboardUserToken({
          apiBaseUrl: config.apiBaseUrl,
          clerkAccessToken: config.authToken,
          audience: "dreamboard-git",
        });
        return {
          token: exchanged.accessToken,
          expiresAt: exchanged.expiresAt,
          audience: "dreamboard-git",
        };
      }

      if (!usesStoredSession(config)) {
        throw new Error(
          "Missing Dreamboard session. Run `dreamboard auth login` to authenticate.",
        );
      }

      return withCredentialLock(async (ops) => {
        const stored = await ops.read();
        const clerk = await resolveFreshClerkAccessToken(config, stored);
        const exchanged = await exchangeDreamboardUserToken({
          apiBaseUrl: config.apiBaseUrl,
          clerkAccessToken: clerk.accessToken,
          audience: "dreamboard-git",
        });

        await ops.writeFull(clerk);

        return {
          token: exchanged.accessToken,
          expiresAt: exchanged.expiresAt,
          audience: "dreamboard-git",
        };
      });
    },

    async logout() {
      await clearCredentials("user_token_manager_logout");
    },
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
): AccessToken | null {
  if (!stored?.dreamboardApiToken) return null;
  if (isFresh(stored.dreamboardApiExpiresAt, stored.dreamboardApiToken)) {
    return {
      token: stored.dreamboardApiToken,
      expiresAt: stored.dreamboardApiExpiresAt,
      audience: "dreamboard-api",
    };
  }
  return null;
}

async function resolveFreshClerkAccessToken(
  config: ResolvedConfig,
  stored: StoredSessionSnapshot | null,
): Promise<Credentials> {
  const accessToken = stored?.accessToken ?? config.clerkAccessToken;
  const refreshToken = stored?.refreshToken ?? config.refreshToken;
  const tokenExpiresAt = stored?.tokenExpiresAt ?? config.clerkAccessExpiresAt;

  if (!refreshToken) {
    throw new Error(
      "Stored Dreamboard session is missing its refresh token. Run `dreamboard auth login` to authenticate again.",
    );
  }

  if (accessToken && isFresh(tokenExpiresAt, accessToken)) {
    return {
      accessToken,
      refreshToken,
      tokenExpiresAt,
      dreamboardApiToken: stored?.dreamboardApiToken,
      dreamboardApiExpiresAt: stored?.dreamboardApiExpiresAt,
      clerkOAuthIssuer: stored?.clerkOAuthIssuer ?? config.clerkOAuthIssuer,
      clerkOAuthClientId:
        stored?.clerkOAuthClientId ?? config.clerkOAuthClientId,
      clerkOAuthTokenUrl:
        stored?.clerkOAuthTokenUrl ?? config.clerkOAuthTokenUrl,
      environment: stored?.environment ?? config.environment,
    };
  }

  const payload = await refreshClerkOAuthToken({
    config: {
      issuer: stored?.clerkOAuthIssuer ?? config.clerkOAuthIssuer,
      clientId: stored?.clerkOAuthClientId ?? config.clerkOAuthClientId,
      tokenUrl: stored?.clerkOAuthTokenUrl ?? config.clerkOAuthTokenUrl,
    },
    refreshToken,
  });

  return {
    accessToken: payload.accessToken,
    refreshToken: payload.refreshToken,
    tokenExpiresAt: payload.expiresAt,
    clerkOAuthIssuer: stored?.clerkOAuthIssuer ?? config.clerkOAuthIssuer,
    clerkOAuthClientId: stored?.clerkOAuthClientId ?? config.clerkOAuthClientId,
    clerkOAuthTokenUrl: payload.tokenUrl,
    environment: stored?.environment ?? config.environment,
  };
}

function isFresh(expiresAt: string | undefined, token: string): boolean {
  const expiry = expiresAt ? new Date(expiresAt) : getJwtExpiry(token);
  return (
    expiry !== null &&
    Number.isFinite(expiry.getTime()) &&
    expiry.getTime() > Date.now() + TOKEN_REFRESH_WINDOW_MS
  );
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
