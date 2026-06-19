export type DreamboardTokenAudience = "dreamboard-api" | "dreamboard-git";

export type DreamboardTokenResponse = {
  accessToken: string;
  tokenType: "Bearer";
  audience: DreamboardTokenAudience;
  expiresIn?: number;
  expiresAt?: string;
};

export async function exchangeDreamboardUserToken(input: {
  apiBaseUrl: string;
  clerkAccessToken: string;
  audience: DreamboardTokenAudience;
  fetchImpl?: typeof fetch;
}): Promise<DreamboardTokenResponse> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const response = await fetchImpl(
    new URL("/api/auth/token-exchange", input.apiBaseUrl),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.clerkAccessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ audience: input.audience }),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Dreamboard token exchange failed (${response.status}). Run \`dreamboard auth login\` to authenticate again.`,
    );
  }

  const payload = (await response.json()) as {
    accessToken?: unknown;
    tokenType?: unknown;
    audience?: unknown;
    expiresIn?: unknown;
  };

  if (typeof payload.accessToken !== "string" || payload.accessToken === "") {
    throw new Error("Dreamboard token exchange response omitted accessToken.");
  }
  if (payload.tokenType !== "Bearer") {
    throw new Error(
      "Dreamboard token exchange response had invalid tokenType.",
    );
  }
  if (payload.audience !== input.audience) {
    throw new Error("Dreamboard token exchange response had wrong audience.");
  }

  const expiresIn =
    typeof payload.expiresIn === "number" && Number.isFinite(payload.expiresIn)
      ? payload.expiresIn
      : undefined;

  return {
    accessToken: payload.accessToken,
    tokenType: "Bearer",
    audience: input.audience,
    expiresIn,
    expiresAt:
      expiresIn === undefined
        ? undefined
        : new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}
