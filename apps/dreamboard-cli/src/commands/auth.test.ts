import { afterEach, expect, mock, test } from "bun:test";
import type { UserSessionStatus } from "@dreamboard-games/cli-core";

const log = mock(() => undefined);
const warn = mock(() => undefined);
const success = mock(() => undefined);
const info = mock(() => undefined);
const start = mock(() => undefined);

const resolvedConfig = {
  environment: "staging" as const,
  apiBaseUrl: "https://api-staging.dreamboard.games",
  webBaseUrl: "https://staging.dreamboard.games",
  authToken: undefined,
  refreshToken: "refresh-token",
  tokenExpiresAt: undefined,
  clerkAccessToken: "clerk-access-token",
  clerkAccessExpiresAt: "2999-01-01T00:00:00.000Z",
  clerkOAuthIssuer: "https://clerk.example.test",
  clerkOAuthClientId: "client-id",
  clerkOAuthTokenUrl: "https://clerk.example.test/oauth/token",
  clerkOAuthScope: "openid profile email offline_access",
  authTokenSource: "none" as const,
  refreshTokenSource: "global" as const,
};

const inspectSession = mock(
  async (): Promise<UserSessionStatus> => ({
    kind: "active" as const,
    sessionKind: "refreshable" as const,
    repaired: true,
    apiToken: {
      token: "dreamboard-api-token",
      expiresAt: "2999-01-01T00:10:00.000Z",
      audience: "dreamboard-api" as const,
    },
  }),
);
const createUserSessionManager = mock(() => ({
  inspectSession,
}));
const getStoredSession = mock(async () => ({
  accessToken: "clerk-access-token",
  refreshToken: "refresh-token",
  environment: "staging",
}));
const getActiveCredentialBackendName = mock(async () => "file" as const);
const loadGlobalConfig = mock(async () => ({
  environment: "staging" as const,
}));
const resolveConfig = mock(() => resolvedConfig);
const parseAuthCommandArgs = mock((args: Record<string, unknown>) => args);

mock.module("consola", () => ({
  default: { log, warn, success, info, start },
}));

mock.module("../build-target.js", () => ({
  IS_PUBLISHED_BUILD: false,
  PUBLISHED_ENVIRONMENT: "prod",
}));

mock.module("../config/global-config.js", () => ({
  getGlobalAuthPath: () => "/tmp/.dreamboard/auth.json",
  getGlobalConfigPath: () => "/tmp/.dreamboard/config.json",
  loadGlobalConfig,
  saveGlobalConfig: mock(async () => undefined),
}));

mock.module("../config/credential-store.js", () => ({
  getStoredSession,
  getActiveCredentialBackendName,
}));

mock.module("../config/resolve.js", () => ({
  getAuthTokenExpiry: () => null,
  resolveConfig,
}));

mock.module("../auth/user-session-manager.js", () => ({
  createUserSessionManager,
}));

mock.module("../flags.js", () => ({
  parseAuthCommandArgs,
}));

mock.module("../services/git/git-credential-helper.js", () => ({
  runGitCredentialHelper: mock(async () => undefined),
}));

const authCommand = (await import("./auth.ts")).default;
const statusCommand = authCommand.subCommands?.status;

afterEach(() => {
  log.mockClear();
  warn.mockClear();
  success.mockClear();
  info.mockClear();
  start.mockClear();
  inspectSession.mockClear();
  inspectSession.mockImplementation(
    async (): Promise<UserSessionStatus> => ({
      kind: "active",
      sessionKind: "refreshable",
      repaired: true,
      apiToken: {
        token: "dreamboard-api-token",
        expiresAt: "2999-01-01T00:10:00.000Z",
        audience: "dreamboard-api",
      },
    }),
  );
  createUserSessionManager.mockClear();
  getStoredSession.mockClear();
  getActiveCredentialBackendName.mockClear();
  loadGlobalConfig.mockClear();
  resolveConfig.mockClear();
  parseAuthCommandArgs.mockClear();
});

test("auth status repairs a Clerk-only session and reports it active", async () => {
  await statusCommand?.run?.({ args: {} } as never);

  expect(createUserSessionManager).toHaveBeenCalledWith(resolvedConfig);
  expect(inspectSession).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith("Session state: active (refreshable)");
  expect(success).toHaveBeenCalledWith(
    "Dreamboard session was repaired and is active.",
  );
  expect(warn).not.toHaveBeenCalledWith("No Dreamboard session found.");
});

test("auth status reports a precise degraded refreshable session", async () => {
  inspectSession.mockImplementationOnce(
    async (): Promise<UserSessionStatus> => ({
      kind: "degraded",
      sessionKind: "refreshable",
      message: "Dreamboard token exchange failed (503).",
    }),
  );

  await statusCommand?.run?.({ args: {} } as never);

  expect(log).toHaveBeenCalledWith("Session state: degraded (refreshable)");
  expect(warn).toHaveBeenCalledWith(
    "Stored Dreamboard session is refreshable but currently API-unusable: Dreamboard token exchange failed (503).",
  );
  expect(warn).not.toHaveBeenCalledWith("No Dreamboard session found.");
});
