import crypto from "node:crypto";
import { defineCommand } from "citty";
import consola from "consola";
import { DEFAULT_LOGIN_TIMEOUT_MS } from "../constants.js";
import { IS_PUBLISHED_BUILD } from "../build-target.js";
import { resolveConfig } from "../config/resolve.js";
import { parseLoginCommandArgs } from "../flags.js";
import {
  getGlobalAuthPath,
  loadGlobalConfig,
  saveGlobalConfig,
} from "../config/global-config.js";
import {
  getStoredSession,
  setCredentials,
} from "../config/credential-store.js";
import { openBrowser, startOAuthCallbackServer } from "../auth/auth-server.js";
import {
  buildClerkAuthorizationUrl,
  createPkcePair,
  exchangeClerkOAuthCode,
} from "../auth/clerk-oauth.js";

export default defineCommand({
  meta: {
    name: "login",
    description:
      "Open browser login and store a refreshable Dreamboard session",
  },
  args: {
    ...(IS_PUBLISHED_BUILD
      ? {}
      : {
          env: {
            type: "string" as const,
            description: "Environment: local | staging | prod",
          },
        }),
  },
  async run({ args }) {
    const parsedArgs = parseLoginCommandArgs(args);
    const [globalConfig, storedSession] = await Promise.all([
      loadGlobalConfig(),
      getStoredSession(),
    ]);
    const config = resolveConfig(
      globalConfig,
      parsedArgs,
      undefined,
      storedSession,
    );
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

    consola.info("Opening browser for login...");
    consola.info(`If the browser does not open, visit: ${loginUrl}`);
    openBrowser(loginUrl);

    consola.start("Waiting for login to complete...");
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

      const resolvedEnvironment = config.environment;

      // Persist environment choice separately from credentials. The
      // credential write itself goes through CredentialStore, which
      // applies atomic-write + 0600 + cross-process lock.
      await saveGlobalConfig({
        ...globalConfig,
        environment: resolvedEnvironment,
      });

      await setCredentials({
        accessToken: tokenResponse.accessToken,
        refreshToken: tokenResponse.refreshToken,
        tokenExpiresAt: tokenResponse.expiresAt,
        clerkOAuthIssuer: config.clerkOAuthIssuer,
        clerkOAuthClientId: config.clerkOAuthClientId,
        clerkOAuthTokenUrl: tokenResponse.tokenUrl,
        environment: resolvedEnvironment,
      });

      consola.success(
        `Login successful. Session saved to ${getGlobalAuthPath()}`,
      );
    } finally {
      server.close();
    }
  },
});
