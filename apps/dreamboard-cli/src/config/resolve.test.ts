import { afterEach, expect, test } from "bun:test";
import { resolveConfig } from "./resolve.js";

const OAUTH_ENV_KEYS = [
  "DREAMBOARD_CLERK_OAUTH_ISSUER",
  "DREAMBOARD_CLERK_OAUTH_CLIENT_ID",
  "DREAMBOARD_CLERK_OAUTH_TOKEN_URL",
  "DREAMBOARD_CLERK_OAUTH_SCOPE",
  "DREAMBOARD_STAGING_CLERK_OAUTH_ISSUER",
  "DREAMBOARD_STAGING_CLERK_OAUTH_CLIENT_ID",
  "DREAMBOARD_STAGING_CLERK_OAUTH_TOKEN_URL",
  "DREAMBOARD_STAGING_CLERK_OAUTH_SCOPE",
  "DREAMBOARD_PROD_CLERK_OAUTH_CLIENT_ID",
] as const;

const originalEnv = new Map<string, string | undefined>(
  OAUTH_ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of OAUTH_ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
});

test("staging resolves the built-in Clerk OAuth registry", () => {
  for (const key of OAUTH_ENV_KEYS) delete process.env[key];

  const config = resolveConfig({}, { env: "staging" });

  expect(config.environment).toBe("staging");
  expect(config.apiBaseUrl).toBe("https://api-staging.dreamboard.games");
  expect(config.webBaseUrl).toBe("https://staging.dreamboard.games");
  expect(config.clerkOAuthIssuer).toBe(
    "https://happy-caribou-19.clerk.accounts.dev",
  );
  expect(config.clerkOAuthTokenUrl).toBe(
    "https://happy-caribou-19.clerk.accounts.dev/oauth/token",
  );
  expect(config.clerkOAuthScope).toBe("openid profile email offline_access");
  expect(config.clerkOAuthClientId).toBe("wkjMF92OFsKbSaGI");
});

test("OAuth env overrides are resolved at call time", () => {
  process.env.DREAMBOARD_STAGING_CLERK_OAUTH_CLIENT_ID = "client-a";

  const first = resolveConfig({}, { env: "staging" });
  expect(first.clerkOAuthClientId).toBe("client-a");

  process.env.DREAMBOARD_STAGING_CLERK_OAUTH_CLIENT_ID = "client-b";

  const second = resolveConfig({}, { env: "staging" });
  expect(second.clerkOAuthClientId).toBe("client-b");
});

test("generic OAuth env overrides are lower priority than environment-scoped overrides", () => {
  process.env.DREAMBOARD_CLERK_OAUTH_CLIENT_ID = "generic-client";
  process.env.DREAMBOARD_STAGING_CLERK_OAUTH_CLIENT_ID = "staging-client";

  const config = resolveConfig({}, { env: "staging" });

  expect(config.clerkOAuthClientId).toBe("staging-client");
});

test("stored OAuth config remains authoritative for an existing refresh token", () => {
  process.env.DREAMBOARD_STAGING_CLERK_OAUTH_CLIENT_ID = "new-client";

  const config = resolveConfig(
    {},
    { env: "staging" },
    undefined,
    {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      environment: "staging",
      clerkOAuthIssuer: "https://stored.example.test",
      clerkOAuthClientId: "stored-client",
      clerkOAuthTokenUrl: "https://stored.example.test/oauth/token",
    },
  );

  expect(config.clerkOAuthIssuer).toBe("https://stored.example.test");
  expect(config.clerkOAuthClientId).toBe("stored-client");
  expect(config.clerkOAuthTokenUrl).toBe(
    "https://stored.example.test/oauth/token",
  );
});
