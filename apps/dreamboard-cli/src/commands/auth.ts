import crypto from "node:crypto";
import { defineCommand } from "citty";
import consola from "consola";
import { startOAuthCallbackServer, openBrowser } from "../auth/auth-server.js";
import {
  buildClerkAuthorizationUrl,
  createPkcePair,
  exchangeClerkOAuthCode,
} from "../auth/clerk-oauth.js";
import { DEFAULT_LOGIN_TIMEOUT_MS } from "../constants.js";
import {
  getGlobalAuthPath,
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
} from "../config/global-config.js";
import {
  clearCredentials,
  getActiveCredentialBackendName,
  getStoredSession,
  setAccessOnlySession,
  setCredentials,
} from "../config/credential-store.js";
import {
  getAuthTokenExpiry,
  refreshResolvedAuthSession,
  resolveConfig,
} from "../config/resolve.js";
import { parseAuthCommandArgs } from "../flags.js";
import { IS_PUBLISHED_BUILD, PUBLISHED_ENVIRONMENT } from "../build-target.js";

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

export default defineCommand({
  meta: { name: "auth", description: "Manage stored Dreamboard sessions" },
  args: {
    action: {
      type: "positional",
      description: IS_PUBLISHED_BUILD
        ? "Action: clear | login"
        : "Action: set | clear | login | env | status",
      required: true,
    },
    ...(IS_PUBLISHED_BUILD
      ? {}
      : {
          tokenValue: {
            type: "positional" as const,
            description: "Token value (for set) or environment name (for env)",
            required: false,
          },
          token: {
            type: "string" as const,
            description: "Auth token (alternative)",
          },
          jwt: {
            type: "boolean" as const,
            description: "Print auth token JSON to stdout",
          },
          env: {
            type: "string" as const,
            description: "Environment: local | staging | prod",
          },
        }),
  },
  async run({ args }) {
    const parsedArgs = parseAuthCommandArgs(args);
    const action = parsedArgs.action;
    const globalConfig = await loadGlobalConfig();

    if (IS_PUBLISHED_BUILD && action !== "login" && action !== "clear") {
      throw new Error(
        "The published Dreamboard CLI only supports browser login and logout. Use `dreamboard login` or `dreamboard logout`.",
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
          "Direct JWT injection is not supported in the published Dreamboard CLI. Use `dreamboard login` so the CLI can store a refreshable session.",
        );
      }
      const token = parsedArgs.tokenValue ?? parsedArgs.token ?? "";
      if (!token) throw new Error("Usage: dreamboard auth set <token>");

      // `auth set` is the power-user "paste a JWT" path. It has no
      // refresh token by construction; calling `setAccessOnlySession`
      // keeps the intent explicit at the storage layer rather than
      // piggybacking on a partial `setCredentials` write.
      await setAccessOnlySession(token);
      consola.success(`Auth token saved to ${getGlobalAuthPath()}.`);
      return;
    }

    if (action === "clear") {
      await clearCredentials();
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
      let accessToken = storedSession?.accessToken;
      let refreshToken = storedSession?.refreshToken;
      let tokenExpiresAt = storedSession?.tokenExpiresAt;
      let clerkOAuthTokenUrl = storedSession?.clerkOAuthTokenUrl;
      let didRefreshStoredSession = false;
      let didUseBrowserLogin = false;
      const resolvedConfig = resolveConfig(
        globalConfig,
        { env: environment },
        undefined,
        storedSession,
      );

      if (accessToken && refreshToken) {
        try {
          const refreshed = await refreshResolvedAuthSession(resolvedConfig);
          accessToken = refreshed?.accessToken ?? accessToken;
          refreshToken = refreshed?.refreshToken ?? refreshToken;
          tokenExpiresAt = refreshed?.tokenExpiresAt ?? tokenExpiresAt;
          clerkOAuthTokenUrl =
            refreshed?.clerkOAuthTokenUrl ?? clerkOAuthTokenUrl;
          didRefreshStoredSession = Boolean(refreshed);
        } catch (error) {
          consola.warn(
            error instanceof Error
              ? error.message
              : "Stored Dreamboard CLI session refresh failed.",
          );
          accessToken = undefined;
          refreshToken = undefined;
        }
      }

      if (!accessToken) {
        const browserLogin = await loginWithBrowser(
          resolvedConfig,
          shouldPrintJwt,
        );
        accessToken = browserLogin.token;
        refreshToken = browserLogin.refreshToken;
        tokenExpiresAt = browserLogin.expiresAt;
        clerkOAuthTokenUrl = browserLogin.tokenUrl;
        didUseBrowserLogin = true;
      }

      if (!accessToken) {
        throw new Error("Login completed but no access token was returned.");
      }

      await saveGlobalConfig({
        ...globalConfig,
        environment: environment as any,
      });

      if (refreshToken) {
        await setCredentials({
          accessToken,
          refreshToken,
          tokenExpiresAt,
          clerkOAuthIssuer: resolvedConfig.clerkOAuthIssuer,
          clerkOAuthClientId: resolvedConfig.clerkOAuthClientId,
          clerkOAuthTokenUrl,
          environment,
        });
      } else {
        await setAccessOnlySession(accessToken);
      }

      if (shouldPrintJwt) {
        process.stdout.write(
          `${JSON.stringify(
            {
              token: accessToken,
              refreshToken: refreshToken ?? null,
              environment,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      if (didUseBrowserLogin) {
        consola.success(
          `Browser login successful. Session saved to ${getGlobalAuthPath()}`,
        );
      } else if (storedSession?.accessToken && didRefreshStoredSession) {
        consola.success(
          `Stored auth session refreshed and saved to ${getGlobalAuthPath()}`,
        );
      } else if (storedSession?.accessToken) {
        consola.success(
          `Stored auth token found. Session data remains in ${getGlobalAuthPath()}`,
        );
      }
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
      const environment =
        parsedArgs.env || globalConfig.environment || "staging";
      const authTokenExpiry = getAuthTokenExpiry(resolvedConfig.authToken);
      const backendName = await getActiveCredentialBackendName();

      consola.log(`Environment: ${environment}`);
      consola.log(`Auth token source: ${resolvedConfig.authTokenSource}`);
      consola.log(`Refresh token source: ${resolvedConfig.refreshTokenSource}`);
      consola.log(
        `Credential backend: ${backendName}${
          backendName === "keychain"
            ? " (OS keychain via @napi-rs/keyring)"
            : ` (${getGlobalAuthPath()})`
        }`,
      );
      const preference = globalConfig.credentialBackend;
      if (preference) {
        consola.log(`Credential backend preference (config): ${preference}`);
      } else {
        consola.log(
          'Credential backend preference (config): file (default; set `"credentialBackend": "keychain"` in config.json to opt in)',
        );
      }
      if (process.env.DREAMBOARD_CREDENTIAL_BACKEND) {
        consola.log(
          `Backend override: DREAMBOARD_CREDENTIAL_BACKEND=${process.env.DREAMBOARD_CREDENTIAL_BACKEND}`,
        );
      }
      consola.log(`Config path: ${getGlobalConfigPath()}`);

      if (!resolvedConfig.authToken) {
        consola.warn("No Dreamboard session found.");
        return;
      }

      if (authTokenExpiry) {
        const isExpired = authTokenExpiry.getTime() <= Date.now();
        consola.log(
          `Access token expires at: ${authTokenExpiry.toISOString()} (${isExpired ? "expired" : "active"})`,
        );

        if (isExpired) {
          if (!resolvedConfig.refreshToken) {
            consola.warn(
              "Access token is expired and no refresh token is available. Run `dreamboard login` to authenticate again.",
            );
            return;
          }

          const refreshed = await refreshResolvedAuthSession(resolvedConfig);

          if (!refreshed?.accessToken) {
            consola.warn(
              "Access token is expired and refresh did not return a new session.",
            );
            return;
          }

          const refreshedExpiry = getAuthTokenExpiry(refreshed.accessToken);
          consola.success("Access token was expired and has been refreshed.");
          if (refreshedExpiry) {
            consola.log(
              `Refreshed access token expires at: ${refreshedExpiry.toISOString()}`,
            );
          }
          return;
        }
      } else {
        consola.log("Access token expiry: unavailable");
      }

      consola.success("Dreamboard session is active.");
      return;
    }

    throw new Error(
      IS_PUBLISHED_BUILD
        ? "Usage:\n  dreamboard auth clear\n  dreamboard auth login"
        : "Usage:\n  dreamboard auth clear\n  dreamboard auth login [--env <local|staging|prod>] [--jwt]\n  dreamboard auth set <token>\n  dreamboard auth env <local|staging|prod>\n  dreamboard auth status [--env <local|staging|prod>]",
    );
  },
});
