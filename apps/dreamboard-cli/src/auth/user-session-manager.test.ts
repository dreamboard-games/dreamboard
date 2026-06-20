import { afterEach, expect, mock, test } from "bun:test";
import type { CredentialBackend } from "../config/credential-store.ts";
import {
  _resetCredentialStoreForTests,
  setCredentialBackendResolver,
} from "../config/credential-store.ts";

const defaultRefresh = async () => ({
  accessToken: "fresh-clerk-token",
  refreshToken: "fresh-refresh-token",
  expiresAt: "2999-01-01T00:00:00.000Z",
  tokenUrl: "https://clerk.example.test/oauth/token",
});
const refreshClerkOAuthToken = mock(defaultRefresh);

const defaultExchange = async ({
  audience,
}: {
  audience: "dreamboard-api" | "dreamboard-git";
}) => ({
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
});
const exchangeDreamboardUserToken = mock(defaultExchange);

mock.module("./clerk-oauth.js", () => ({
  refreshClerkOAuthToken,
}));

mock.module("./token-exchange.js", () => ({
  exchangeDreamboardUserToken,
}));

const { createUserSessionManager } = await import("./user-session-manager.ts");

afterEach(() => {
  _resetCredentialStoreForTests();
  refreshClerkOAuthToken.mockClear();
  refreshClerkOAuthToken.mockImplementation(defaultRefresh);
  exchangeDreamboardUserToken.mockClear();
  exchangeDreamboardUserToken.mockImplementation(defaultExchange);
});

test("repairs a Clerk-only session by exchanging and caching an API token", async () => {
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

  const status = await createUserSessionManager(baseConfig()).inspectSession();

  expect(status).toMatchObject({
    kind: "active",
    sessionKind: "refreshable",
    repaired: true,
    apiToken: { token: "dreamboard-api-token" },
  });
  expect(refreshClerkOAuthToken).not.toHaveBeenCalled();
  expect(writes).toEqual([
    expect.objectContaining({
      accessToken: "clerk-access-token",
      refreshToken: "clerk-refresh-token",
      dreamboardApiToken: "dreamboard-api-token",
      dreamboardApiExpiresAt: "2999-01-01T00:10:00.000Z",
    }),
  ]);
});

test("reuses a cached Dreamboard API token without Clerk refresh or exchange", async () => {
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

  const token = await createUserSessionManager(baseConfig()).resolveApiToken();

  expect(token?.token).toBe("cached-api-token");
  expect(refreshClerkOAuthToken).not.toHaveBeenCalled();
  expect(exchangeDreamboardUserToken).not.toHaveBeenCalled();
});

test("refreshes Clerk credentials and finishes with a complete API session", async () => {
  const writes: unknown[] = [];
  const backend = memoryBackend(
    {
      accessToken: "expired-clerk-token",
      refreshToken: "clerk-refresh-token",
      tokenExpiresAt: "2000-01-01T00:00:00.000Z",
      environment: "prod",
    },
    writes,
  );
  setCredentialBackendResolver(() => backend);

  const token = await createUserSessionManager(baseConfig()).resolveApiToken();
  const finalSession = await backend.read();

  expect(token?.token).toBe("dreamboard-api-token");
  expect(refreshClerkOAuthToken).toHaveBeenCalledTimes(1);
  expect(exchangeDreamboardUserToken).toHaveBeenCalledWith({
    apiBaseUrl: "https://api.dreamboard.test",
    clerkAccessToken: "fresh-clerk-token",
    audience: "dreamboard-api",
  });
  expect(finalSession).toMatchObject({
    accessToken: "fresh-clerk-token",
    refreshToken: "fresh-refresh-token",
    dreamboardApiToken: "dreamboard-api-token",
    dreamboardApiExpiresAt: "2999-01-01T00:10:00.000Z",
  });
  expect(writes.at(-1)).toEqual(finalSession);
});

test("Git token resolution preserves the API cache when Clerk refreshes", async () => {
  const writes: unknown[] = [];
  setCredentialBackendResolver(() =>
    memoryBackend(
      {
        accessToken: "expired-clerk-token",
        refreshToken: "clerk-refresh-token",
        tokenExpiresAt: "2000-01-01T00:00:00.000Z",
        dreamboardApiToken: "cached-api-token",
        dreamboardApiExpiresAt: "2999-01-01T00:10:00.000Z",
        environment: "prod",
      },
      writes,
    ),
  );

  const token = await createUserSessionManager(baseConfig()).resolveGitToken();

  expect(token.token).toBe("dreamboard-git-token");
  expect(refreshClerkOAuthToken).toHaveBeenCalledTimes(1);
  expect(writes).toEqual([
    expect.objectContaining({
      accessToken: "fresh-clerk-token",
      refreshToken: "fresh-refresh-token",
      dreamboardApiToken: "cached-api-token",
      dreamboardApiExpiresAt: "2999-01-01T00:10:00.000Z",
    }),
  ]);
  expect(JSON.stringify(writes)).not.toContain("dreamboard-git-token");
});

test("persists a rotated Clerk refresh token before API exchange failure", async () => {
  const writes: unknown[] = [];
  setCredentialBackendResolver(() =>
    memoryBackend(
      {
        accessToken: "expired-clerk-token",
        refreshToken: "clerk-refresh-token",
        tokenExpiresAt: "2000-01-01T00:00:00.000Z",
        dreamboardApiToken: "expired-api-token",
        dreamboardApiExpiresAt: "2000-01-01T00:10:00.000Z",
        environment: "prod",
      },
      writes,
    ),
  );
  exchangeDreamboardUserToken.mockImplementationOnce(async () => {
    throw new Error("Dreamboard token exchange failed (503).");
  });

  await expect(
    createUserSessionManager(baseConfig()).resolveApiToken(),
  ).rejects.toThrow("Dreamboard token exchange failed (503).");

  expect(writes).toEqual([
    expect.objectContaining({
      accessToken: "fresh-clerk-token",
      refreshToken: "fresh-refresh-token",
      dreamboardApiToken: "expired-api-token",
      dreamboardApiExpiresAt: "2000-01-01T00:10:00.000Z",
    }),
  ]);
});

test("establishing a login persists the refreshable session before exchange", async () => {
  const writes: unknown[] = [];
  setCredentialBackendResolver(() => memoryBackend(null, writes));
  exchangeDreamboardUserToken.mockImplementationOnce(async () => {
    throw new Error("Dreamboard token exchange failed (503).");
  });

  await expect(
    createUserSessionManager(baseConfig()).establishRefreshableSession({
      clerkAccessToken: "new-clerk-token",
      refreshToken: "new-refresh-token",
      clerkAccessExpiresAt: "2999-01-01T00:00:00.000Z",
      environment: "prod",
    }),
  ).rejects.toThrow("Dreamboard token exchange failed (503).");

  expect(writes).toEqual([
    expect.objectContaining({
      accessToken: "new-clerk-token",
      refreshToken: "new-refresh-token",
    }),
  ]);
});

test("concurrent API and Git resolution cannot clobber rotated credentials", async () => {
  const writes: unknown[] = [];
  const backend = memoryBackend(
    {
      accessToken: "expired-clerk-token",
      refreshToken: "clerk-refresh-token",
      tokenExpiresAt: "2000-01-01T00:00:00.000Z",
      environment: "prod",
    },
    writes,
  );
  setCredentialBackendResolver(() => backend);
  const manager = createUserSessionManager(baseConfig());

  const [apiToken, gitToken] = await Promise.all([
    manager.resolveApiToken(),
    manager.resolveGitToken(),
  ]);
  const finalSession = await backend.read();

  expect(apiToken?.token).toBe("dreamboard-api-token");
  expect(gitToken.token).toBe("dreamboard-git-token");
  expect(refreshClerkOAuthToken).toHaveBeenCalledTimes(1);
  expect(finalSession).toMatchObject({
    accessToken: "fresh-clerk-token",
    refreshToken: "fresh-refresh-token",
    dreamboardApiToken: "dreamboard-api-token",
    dreamboardApiExpiresAt: "2999-01-01T00:10:00.000Z",
  });
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
