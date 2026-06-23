import {
  exchangeAuthToken,
  type TokenExchangeAudience,
  type TokenExchangeResponse,
} from "@dreamboard-games/api-client";

export type DreamboardTokenAudience = TokenExchangeAudience;

export type DreamboardTokenResponse = TokenExchangeResponse & {
  expiresAt?: string;
};

export async function exchangeDreamboardUserToken(input: {
  apiBaseUrl: string;
  clerkAccessToken: string;
  audience: DreamboardTokenAudience;
  fetchImpl?: typeof fetch;
}): Promise<DreamboardTokenResponse> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const { data, error, response } = await exchangeAuthToken({
    baseUrl: input.apiBaseUrl,
    auth: input.clerkAccessToken,
    body: { audience: input.audience },
    fetch: fetchImpl,
  });

  if (error || !data) {
    const status = response?.status ?? "no response";
    throw new Error(
      `Dreamboard token exchange failed (${status}). Run \`dreamboard auth login\` to authenticate again.`,
    );
  }

  if (data.accessToken === "") {
    throw new Error("Dreamboard token exchange response omitted accessToken.");
  }
  if (data.tokenType !== "Bearer") {
    throw new Error(
      "Dreamboard token exchange response had invalid tokenType.",
    );
  }
  if (data.audience !== input.audience) {
    throw new Error("Dreamboard token exchange response had wrong audience.");
  }

  return {
    ...data,
    expiresAt:
      data.expiresIn === undefined
        ? undefined
        : new Date(Date.now() + data.expiresIn * 1000).toISOString(),
  };
}
