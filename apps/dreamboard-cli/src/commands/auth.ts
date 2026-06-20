import crypto from "node:crypto";
import { defineCommand } from "citty";
import consola from "consola";
import { startOAuthCallbackServer, openBrowser } from "../auth/auth-server.js";
import {
  buildClerkAuthorizationUrl,
  createPkcePair,
  exchangeClerkOAuthCode,
} from "../auth/clerk-oauth.js";
import { createUserSessionManager } from "../auth/user-session-manager.js";
import { DEFAULT_LOGIN_TIMEOUT_MS } from "../constants.js";
import {
  getGlobalAuthPath,
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
} from "../config/global-config.js";
import {
  getActiveCredentialBackendName,
  getStoredSession,
} from "../config/credential-store.js";
import { getAuthTokenExpiry, resolveConfig } from "../config/resolve.js";
import { parseAuthCommandArgs } from "../flags.js";
import { IS_PUBLISHED_BUILD, PUBLISHED_ENVIRONMENT } from "../build-target.js";
import { runGitCredentialHelper } from "../services/git/git-credential-helper.js";

async function loginWithBrowser(
  config: ReturnType<typeof resolveConfig>,
  quiet: boolean,
): Promise<{
  token: string;
  refreshToken: string;
  expiresAt?: string;
  tokenUrl: string;
}> {
  const state = crypto.randomUUID();
  const pkce = createPkcePair();
  const server = await startOAuthCallbackServer(
    state,
    DEFAULT_LOGIN_TIMEOUT_MS,
  );
  const loginUrl = buildClerkAuthorizationUrl({
    config: {
      issuer: config.clerkOAuthIssuer,
      clientId: config.clerkOAuthClientId,
      tokenUrl: config.clerkOAuthTokenUrl,
      scope: config.clerkOAuthScope,
    },
    redirectUri: server.redirectUri,
    state,
    codeChallenge: pkce.challenge,
  }).toString();

  if (!quiet) {
    consola.info("Opening browser for login...");
    consola.info(`If the browser does not open, visit: ${loginUrl}`);
  }

  openBrowser(loginUrl);

  if (!quiet) {
    consola.start("Waiting for login to complete...");
  }

  try {
    const { code } = await server.waitForCode;
    const tokenResponse = await exchangeClerkOAuthCode({
      config: {
        issuer: config.clerkOAuthIssuer,
        clientId: config.clerkOAuthClientId,
        tokenUrl: config.clerkOAuthTokenUrl,
      },
      code,
      redirectUri: server.redirectUri,
      codeVerifier: pkce.verifier,
    });
    return {
      token: tokenResponse.accessToken,
      refreshToken: tokenResponse.refreshToken,
      expiresAt: tokenResponse.expiresAt,
      tokenUrl: tokenResponse.tokenUrl,
    };
  } finally {
    server.close();
  }
}

async function runAuthAction(rawArgs: unknown): Promise<void> {
  const parsedArgs = parseAuthCommandArgs(rawArgs);
  const action = parsedArgs.action;
  const globalConfig = await loadGlobalConfig();

  if (action === "git-credential") {
    await runGitCredentialHelper();
    return;
  }

  if (IS_PUBLISHED_BUILD && action !== "login" && action !== "logout") {
    throw new Error(
      "The published Dreamboard CLI only supports browser login and logout. Use `dreamboard auth login` or `dreamboard auth logout`.",
    );
  }

  if (action === "env") {
    if (IS_PUBLISHED_BUILD) {
      throw new Error(
        "The published Dreamboard CLI is production-only and does not support switching environments.",
      );
    }
    const environment = parsedArgs.tokenValue ?? parsedArgs.env;
    if (!environment) {
      throw new Error("Usage: dreamboard auth env <local|staging|prod>");
    }
    if (!["local", "staging", "prod"].includes(environment)) {
      throw new Error(
        `Invalid environment '${environment}'. Valid options: local, staging, prod`,
      );
    }
    await saveGlobalConfig({
      ...globalConfig,
      environment: environment as any,
    });
    consola.success(`Environment set to '${environment}'.`);
    return;
  }

  if (action === "set") {
    if (IS_PUBLISHED_BUILD) {
      throw new Error(
        "Direct JWT injection is not supported in the published Dreamboard CLI. Use `dreamboard auth login` so the CLI can store a refreshable session.",
      );
    }
    const token = parsedArgs.tokenValue ?? parsedArgs.token ?? "";
    if (!token) throw new Error("Usage: dreamboard auth set <token>");

    // `auth set` is the power-user "paste a JWT" path. It has no refresh
    // token by construction, so establish an explicit access-only session.
    const config = resolveConfig(
      globalConfig,
      { env: parsedArgs.env },
      undefined,
      await getStoredSession(),
    );
    await createUserSessionManager(config).establishAccessOnlySession(token);
    consola.success(`Auth token saved to ${getGlobalAuthPath()}.`);
    return;
  }

  if (action === "logout") {
    const config = resolveConfig(
      globalConfig,
      { env: parsedArgs.env },
      undefined,
      await getStoredSession(),
    );
    await createUserSessionManager(config).logout();
    consola.success(
      `Stored Dreamboard session cleared from ${getGlobalAuthPath()}.`,
    );
    return;
  }

  if (action === "login") {
    const shouldPrintJwt = !IS_PUBLISHED_BUILD && parsedArgs.jwt === true;
    const environment = IS_PUBLISHED_BUILD
      ? PUBLISHED_ENVIRONMENT
      : parsedArgs.env || globalConfig.environment || "staging";

    const storedSession = await getStoredSession();
    const resolvedConfig = resolveConfig(
      globalConfig,
      { env: environment },
      undefined,
      storedSession,
    );
    const sessionManager = createUserSessionManager(resolvedConfig);
    const existingStatus = await sessionManager.inspectSession();

    if (existingStatus.kind === "active") {
      if (shouldPrintJwt) {
        const current = await getStoredSession();
        process.stdout.write(
          `${JSON.stringify(
            {
              token: current?.accessToken ?? existingStatus.apiToken.token,
              refreshToken: current?.refreshToken ?? null,
              environment,
            },
            null,
            2,
          )}\n`,
        );
      } else if (existingStatus.repaired) {
        consola.success(
          `Stored Dreamboard session repaired and saved to ${getGlobalAuthPath()}`,
        );
      } else {
        consola.success(
          `Stored Dreamboard session is active in ${getGlobalAuthPath()}`,
        );
      }
      return;
    }

    if (
      existingStatus.kind === "degraded" ||
      existingStatus.kind === "invalid"
    ) {
      consola.warn(existingStatus.message);
    }

    const browserLogin = await loginWithBrowser(resolvedConfig, shouldPrintJwt);
    await saveGlobalConfig({
      ...globalConfig,
      environment: environment as any,
    });
    await sessionManager.establishRefreshableSession({
      clerkAccessToken: browserLogin.token,
      refreshToken: browserLogin.refreshToken,
      clerkAccessExpiresAt: browserLogin.expiresAt,
      clerkOAuthIssuer: resolvedConfig.clerkOAuthIssuer,
      clerkOAuthClientId: resolvedConfig.clerkOAuthClientId,
      clerkOAuthTokenUrl: browserLogin.tokenUrl,
      environment,
    });

    if (shouldPrintJwt) {
      process.stdout.write(
        `${JSON.stringify(
          {
            token: browserLogin.token,
            refreshToken: browserLogin.refreshToken,
            environment,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    consola.success(
      `Browser login successful. Session saved to ${getGlobalAuthPath()}`,
    );
    return;
  }

  if (action === "status") {
    const storedSession = await getStoredSession();
    const resolvedConfig = resolveConfig(
      globalConfig,
      { env: parsedArgs.env },
      undefined,
      storedSession,
    );
    const environment = parsedArgs.env || globalConfig.environment || "staging";
    const status =
      await createUserSessionManager(resolvedConfig).inspectSession();
    const backendName = await getActiveCredentialBackendName();

    consola.log(`Environment: ${environment}`);
    consola.log(
      `Credential backend: ${backendName}${
        backendName === "keychain"
          ? " (OS keychain via @napi-rs/keyring)"
          : ` (${getGlobalAuthPath()})`
      }`,
    );
    consola.log(`Config path: ${getGlobalConfigPath()}`);

    if (status.kind === "none") {
      consola.log("Session state: none");
      consola.warn("No Dreamboard session found.");
      return;
    }

    if (status.kind === "degraded") {
      consola.log("Session state: degraded (refreshable)");
      consola.warn(
        `Stored Dreamboard session is refreshable but currently API-unusable: ${status.message}`,
      );
      return;
    }

    if (status.kind === "invalid") {
      consola.log(`Session state: invalid (${status.sessionKind})`);
      consola.warn(status.message);
      return;
    }

    consola.log(`Session state: active (${status.sessionKind})`);
    const authTokenExpiry =
      status.apiToken.expiresAt !== undefined
        ? new Date(status.apiToken.expiresAt)
        : getAuthTokenExpiry(status.apiToken.token);
    if (authTokenExpiry && Number.isFinite(authTokenExpiry.getTime())) {
      consola.log(
        `Dreamboard API token expires at: ${authTokenExpiry.toISOString()} (active)`,
      );
    } else {
      consola.log("Dreamboard API token expiry: unavailable");
    }

    consola.success(
      status.repaired
        ? "Dreamboard session was repaired and is active."
        : "Dreamboard session is active.",
    );
    return;
  }

  throw new Error(
    IS_PUBLISHED_BUILD
      ? "Usage:\n  dreamboard auth login\n  dreamboard auth logout"
      : "Usage:\n  dreamboard auth login [--env <local|staging|prod>] [--jwt]\n  dreamboard auth logout\n  dreamboard auth set <token>\n  dreamboard auth env <local|staging|prod>\n  dreamboard auth status [--env <local|staging|prod>]",
  );
}

function defineAuthActionCommand(options: {
  name: string;
  description: string;
  action: ReturnType<typeof parseAuthCommandArgs>["action"];
  args?: any;
  hidden?: boolean;
}) {
  return defineCommand({
    meta: {
      name: options.name,
      description: options.description,
      hidden: options.hidden,
    },
    args: options.args ?? {},
    async run({ args }) {
      await runAuthAction({ ...args, action: options.action });
    },
  });
}

export default defineCommand({
  meta: { name: "auth", description: "Manage stored Dreamboard sessions" },
  subCommands: {
    login: defineAuthActionCommand({
      name: "login",
      description: "Open browser login and store a refreshable session",
      action: "login",
      args: IS_PUBLISHED_BUILD
        ? {}
        : {
            env: {
              type: "string" as const,
              description: "Environment: local | staging | prod",
            },
            jwt: {
              type: "boolean" as const,
              description: "Print auth token JSON to stdout",
            },
          },
    }),
    logout: defineAuthActionCommand({
      name: "logout",
      description: "Clear the stored Dreamboard session",
      action: "logout",
    }),
    status: defineAuthActionCommand({
      name: "status",
      description: "Show stored Dreamboard session status",
      action: "status",
      args: IS_PUBLISHED_BUILD
        ? {}
        : {
            env: {
              type: "string" as const,
              description: "Environment: local | staging | prod",
            },
          },
    }),
    "git-credential": defineAuthActionCommand({
      name: "git-credential",
      description: "Resolve Git credentials for Dreamboard remotes",
      action: "git-credential",
      hidden: true,
    }),
  },
});
