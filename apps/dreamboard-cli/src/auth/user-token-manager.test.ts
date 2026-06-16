import { afterEach, expect, mock, test } from "bun:test";
import type { CredentialBackend } from "../config/credential-store.ts";
import {
  _resetCredentialStoreForTests,
  setCredentialBackendResolver,
} from "../config/credential-store.ts";

const refreshClerkOAuthToken = mock(async () => ({
  accessToken: "fresh-clerk-token",
  refreshToken: "fresh-refresh-token",
  expiresAt: "2999-01-01T00:00:00.000Z",
  tokenUrl: "https://clerk.example.test/oauth/token",
}));

const exchangeDreamboardUserToken = mock(
  async ({ audience }: { audience: "dreamboard-api" | "dreamboard-git" }) => ({
    accessToken:
      audience === "dreamboard-api"
        ? "dreamboard-api-token"
        : "dreamboard-git-token",
    tokenType: "Bearer" as const,
    audience,
    expiresIn: audience === "dreamboard-api" ? 600 : 120,
    expiresAt:
      audience === "dreamboard-api"
        ? "2999-01-01T00:10:00.000Z"
        : "2999-01-01T00:02:00.000Z",
  }),
);

mock.module("./clerk-oauth.js", () => ({
  refreshClerkOAuthToken,
}));

mock.module("./token-exchange.js", () => ({
  exchangeDreamboardUserToken,
}));

const { createUserTokenManager } = await import("./user-token-manager.ts");

afterEach(() => {
  _resetCredentialStoreForTests();
  refreshClerkOAuthToken.mockClear();
  exchangeDreamboardUserToken.mockClear();
});

test("resolves API token by exchanging Clerk token and stores only API cache", async () => {
  const writes: unknown[] = [];
  setCredentialBackendResolver(() =>
    memoryBackend(
      {
        accessToken: "clerk-access-token",
        refreshToken: "clerk-refresh-token",
        tokenExpiresAt: "2999-01-01T00:00:00.000Z",
        environment: "prod",
      },
      writes,
    ),
  );

  const token = await createUserTokenManager(baseConfig()).resolveApiToken();

  expect(token?.token).toBe("dreamboard-api-token");
  expect(refreshClerkOAuthToken).not.toHaveBeenCalled();
  expect(exchangeDreamboardUserToken).toHaveBeenCalledWith({
    apiBaseUrl: "https://api.dreamboard.test",
    clerkAccessToken: "clerk-access-token",
    audience: "dreamboard-api",
  });
  expect(writes).toEqual([
    expect.objectContaining({
      accessToken: "clerk-access-token",
      refreshToken: "clerk-refresh-token",
      dreamboardApiToken: "dreamboard-api-token",
      dreamboardApiExpiresAt: "2999-01-01T00:10:00.000Z",
    }),
  ]);
});

test("reuses cached Dreamboard API token without Clerk refresh or exchange", async () => {
  setCredentialBackendResolver(() =>
    memoryBackend({
      accessToken: "clerk-access-token",
      refreshToken: "clerk-refresh-token",
      tokenExpiresAt: "2999-01-01T00:00:00.000Z",
      dreamboardApiToken: "cached-api-token",
      dreamboardApiExpiresAt: "2999-01-01T00:10:00.000Z",
      environment: "prod",
    }),
  );

  const token = await createUserTokenManager(baseConfig()).resolveApiToken();

  expect(token?.token).toBe("cached-api-token");
  expect(refreshClerkOAuthToken).not.toHaveBeenCalled();
  expect(exchangeDreamboardUserToken).not.toHaveBeenCalled();
});

test("resolves Git token in memory without storing it", async () => {
  const writes: unknown[] = [];
  setCredentialBackendResolver(() =>
    memoryBackend(
      {
        accessToken: "clerk-access-token",
        refreshToken: "clerk-refresh-token",
        tokenExpiresAt: "2999-01-01T00:00:00.000Z",
        dreamboardApiToken: "cached-api-token",
        dreamboardApiExpiresAt: "2999-01-01T00:10:00.000Z",
        environment: "prod",
      },
      writes,
    ),
  );

  const token = await createUserTokenManager(baseConfig()).resolveGitToken();

  expect(token.token).toBe("dreamboard-git-token");
  expect(exchangeDreamboardUserToken).toHaveBeenCalledWith({
    apiBaseUrl: "https://api.dreamboard.test",
    clerkAccessToken: "clerk-access-token",
    audience: "dreamboard-git",
  });
  expect(JSON.stringify(writes)).not.toContain("dreamboard-git-token");
});

function baseConfig() {
  return {
    environment: "prod" as const,
    apiBaseUrl: "https://api.dreamboard.test",
    webBaseUrl: "https://dreamboard.test",
    authToken: undefined,
    refreshToken: "clerk-refresh-token",
    tokenExpiresAt: undefined,
    clerkAccessToken: "clerk-access-token",
    clerkAccessExpiresAt: "2999-01-01T00:00:00.000Z",
    clerkOAuthIssuer: "https://clerk.example.test",
    clerkOAuthClientId: "client-id",
    clerkOAuthTokenUrl: "https://clerk.example.test/oauth/token",
    authTokenSource: "global" as const,
    refreshTokenSource: "global" as const,
  };
}

function memoryBackend(
  initial: Awaited<ReturnType<CredentialBackend["read"]>>,
  writes: unknown[] = [],
): CredentialBackend {
  let current = initial;
  return {
    name: "keychain",
    async read() {
      return current;
    },
    async writeFull(creds) {
      current = creds;
      writes.push(creds);
    },
    async writeAccessOnly(accessToken) {
      current = { accessToken };
      writes.push(current);
    },
    async clear() {
      current = null;
      writes.push(null);
    },
  };
}
