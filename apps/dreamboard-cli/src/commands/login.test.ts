import { expect, mock, test } from "bun:test";

const resolvedConfig = {
  environment: "prod",
  webBaseUrl: "https://dreamboard.games",
  apiBaseUrl: "https://api.dreamboard.games",
  clerkOAuthIssuer: "https://clerk.example.test",
  clerkOAuthClientId: "public-client-id",
  clerkOAuthTokenUrl: "https://clerk.example.test/oauth/token",
  clerkOAuthScope: "openid profile email offline_access",
};

const resolveConfig = mock(() => resolvedConfig);
const loadGlobalConfig = mock(async () => ({}));
const saveGlobalConfig = mock(async () => undefined);
const getStoredSession = mock(async () => null);
const establishRefreshableSession = mock(async () => ({
  token: "dreamboard-api-token",
  expiresAt: "2026-06-16T00:10:00.000Z",
  audience: "dreamboard-api" as const,
}));
const createUserSessionManager = mock(() => ({
  establishRefreshableSession,
}));
const closeServer = mock(() => undefined);
const startOAuthCallbackServer = mock(async () => ({
  redirectUri: "http://127.0.0.1:6207/oauth/callback",
  waitForCode: Promise.resolve({ code: "oauth-code" }),
  close: closeServer,
}));
const openBrowser = mock(() => undefined);
const createPkcePair = mock(() => ({
  verifier: "pkce-verifier",
  challenge: "pkce-challenge",
}));
const exchangeClerkOAuthCode = mock(async () => ({
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: "2026-06-16T00:00:00.000Z",
  tokenUrl: "https://clerk.example.test/oauth/token",
}));
const parseLoginCommandArgs = mock((args: Record<string, unknown>) => args);

mock.module("../build-target.js", () => ({
  CAN_SELECT_ENVIRONMENT: false,
  IS_PUBLISHED_BUILD: true,
  PUBLISHED_ENVIRONMENT: "prod",
}));

mock.module("../config/resolve.js", () => ({
  resolveConfig,
}));

mock.module("../config/global-config.js", () => ({
  getGlobalAuthPath: () => "/tmp/.dreamboard/auth.json",
  loadGlobalConfig,
  saveGlobalConfig,
}));

mock.module("../config/credential-store.js", () => ({
  getStoredSession,
}));

mock.module("../auth/auth-server.js", () => ({
  startOAuthCallbackServer,
  openBrowser,
}));

mock.module("../auth/clerk-oauth.js", () => ({
  createPkcePair,
  buildClerkAuthorizationUrl: ({
    config,
    redirectUri,
    state,
    codeChallenge,
  }: {
    config: {
      issuer?: string;
      clientId?: string;
      scope?: string;
    };
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }) => {
    const url = new URL("/oauth/authorize", config.issuer);
    url.searchParams.set("client_id", config.clientId ?? "");
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("scope", config.scope ?? "");
    return url;
  },
  exchangeClerkOAuthCode,
}));

mock.module("../auth/user-session-manager.js", () => ({
  createUserSessionManager,
}));

mock.module("../flags.js", () => ({
  parseLoginCommandArgs,
}));

const loginCommand = (await import("./login.ts")).default;

test("published login uses direct Clerk OAuth and stores refreshable credentials", async () => {
  resolveConfig.mockClear();
  loadGlobalConfig.mockClear();
  saveGlobalConfig.mockClear();
  getStoredSession.mockClear();
  createUserSessionManager.mockClear();
  establishRefreshableSession.mockClear();
  startOAuthCallbackServer.mockClear();
  closeServer.mockClear();
  openBrowser.mockClear();
  createPkcePair.mockClear();
  exchangeClerkOAuthCode.mockClear();
  parseLoginCommandArgs.mockClear();

  await loginCommand.run({
    args: {},
  });

  expect(parseLoginCommandArgs).toHaveBeenCalledWith({});
  expect(resolveConfig).toHaveBeenCalledWith({}, {}, undefined, null);
  expect(startOAuthCallbackServer).toHaveBeenCalledTimes(1);
  expect(openBrowser).toHaveBeenCalledTimes(1);
  const openedUrl = new URL(openBrowser.mock.calls[0]?.[0] as string);
  expect(openedUrl.origin).toBe("https://clerk.example.test");
  expect(openedUrl.pathname).toBe("/oauth/authorize");
  expect(openedUrl.searchParams.get("client_id")).toBe("public-client-id");
  expect(openedUrl.searchParams.get("redirect_uri")).toBe(
    "http://127.0.0.1:6207/oauth/callback",
  );
  expect(openedUrl.searchParams.get("code_challenge")).toBe("pkce-challenge");
  expect(openedUrl.searchParams.get("scope")).toBe(
    "openid profile email offline_access",
  );

  expect(exchangeClerkOAuthCode).toHaveBeenCalledWith({
    config: {
      issuer: "https://clerk.example.test",
      clientId: "public-client-id",
      tokenUrl: "https://clerk.example.test/oauth/token",
    },
    code: "oauth-code",
    redirectUri: "http://127.0.0.1:6207/oauth/callback",
    codeVerifier: "pkce-verifier",
  });
  expect(saveGlobalConfig).toHaveBeenCalledWith({
    environment: "prod",
  });
  expect(createUserSessionManager).toHaveBeenCalledWith(resolvedConfig);
  expect(establishRefreshableSession).toHaveBeenCalledWith({
    clerkAccessToken: "access-token",
    refreshToken: "refresh-token",
    clerkAccessExpiresAt: "2026-06-16T00:00:00.000Z",
    clerkOAuthIssuer: "https://clerk.example.test",
    clerkOAuthClientId: "public-client-id",
    clerkOAuthTokenUrl: "https://clerk.example.test/oauth/token",
    environment: "prod",
  });
  expect(closeServer).toHaveBeenCalledTimes(1);
});
