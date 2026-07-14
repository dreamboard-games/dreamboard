import crypto from "node:crypto";

export type ClerkOAuthConfig = {
  issuer?: string;
  clientId?: string;
  tokenUrl?: string;
  scope?: string;
};

export type ClerkOAuthTokenResponse = {
  accessToken: string;
  refreshToken: string;
  expiresAt?: string;
  tokenUrl: string;
};

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(crypto.randomBytes(32));
  const challenge = base64Url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

export function buildClerkAuthorizationUrl(input: {
  config: ClerkOAuthConfig;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): URL {
  const { issuer, clientId, scope } = assertConfigured(input.config);
  const url = new URL("/oauth/authorize", issuer);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("scope", scope ?? "openid profile email offline_access");
  return url;
}

export async function exchangeClerkOAuthCode(input: {
  config: ClerkOAuthConfig;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<ClerkOAuthTokenResponse> {
  const { clientId, tokenUrl } = assertConfigured(input.config);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    code: input.code,
    redirect_uri: input.redirectUri,
    code_verifier: input.codeVerifier,
  });
  return requestClerkToken(tokenUrl, body);
}

export async function refreshClerkOAuthToken(input: {
  config: ClerkOAuthConfig;
  refreshToken: string;
}): Promise<ClerkOAuthTokenResponse> {
  const { clientId, tokenUrl } = assertConfigured(input.config);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: input.refreshToken,
  });
  return requestClerkToken(tokenUrl, body);
}

function assertConfigured(config: ClerkOAuthConfig): {
  issuer: string;
  clientId: string;
  tokenUrl: string;
  scope?: string;
} {
  const issuer = config.issuer?.trim().replace(/\/$/, "");
  const clientId = config.clientId?.trim();
  if (!issuer || !clientId) {
    throw new Error(
      [
        "Clerk OAuth CLI is not configured for this environment.",
        "The CLI expects first-party environments to be configured in its built-in registry.",
        "If this environment has no registered public Clerk OAuth client, create one and release a CLI with its client id.",
        "For emergency overrides, set the environment-specific DREAMBOARD_<ENV>_CLERK_OAUTH_* variables or DREAMBOARD_CLERK_OAUTH_*.",
        "For local harness auth, use `pnpm auth:local` or the auto-bootstrapped local harness flows instead.",
      ].join(" "),
    );
  }
  return {
    issuer,
    clientId,
    tokenUrl:
      config.tokenUrl?.trim() || new URL("/oauth/token", issuer).toString(),
    scope: config.scope?.trim() || undefined,
  };
}

async function requestClerkToken(
  tokenUrl: string,
  body: URLSearchParams,
): Promise<ClerkOAuthTokenResponse> {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Clerk OAuth token request failed (${response.status}): ${detail}`,
    );
  }
  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  };
  if (typeof payload.access_token !== "string") {
    throw new Error("Clerk OAuth token response did not include access_token.");
  }
  if (typeof payload.refresh_token !== "string") {
    throw new Error(
      "Clerk OAuth token response did not include refresh_token.",
    );
  }
  const expiresAt =
    typeof payload.expires_in === "number"
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : undefined;
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt,
    tokenUrl,
  };
}

function base64Url(bytes: Buffer): string {
  return bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
