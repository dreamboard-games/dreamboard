import { expect, mock, test } from "bun:test";
import { exchangeDreamboardUserToken } from "./token-exchange.ts";

test("token exchange posts Clerk bearer and requested audience", async () => {
  const fetchImpl = mock(
    async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(String(_url)).toBe(
        "https://api.dreamboard.test/api/auth/token-exchange",
      );
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer clerk-access-token",
      );
      expect(JSON.parse(String(init?.body))).toEqual({
        audience: "dreamboard-api",
      });
      return new Response(
        JSON.stringify({
          accessToken: "dreamboard-api-token",
          tokenType: "Bearer",
          audience: "dreamboard-api",
          expiresIn: 600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const exchanged = await exchangeDreamboardUserToken({
    apiBaseUrl: "https://api.dreamboard.test",
    clerkAccessToken: "clerk-access-token",
    audience: "dreamboard-api",
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

  expect(exchanged.accessToken).toBe("dreamboard-api-token");
  expect(exchanged.audience).toBe("dreamboard-api");
  expect(exchanged.expiresAt).toBeDefined();
});

test("token exchange rejects wrong audience responses", async () => {
  const fetchImpl = mock(
    async () =>
      new Response(
        JSON.stringify({
          accessToken: "dreamboard-git-token",
          tokenType: "Bearer",
          audience: "dreamboard-git",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );

  await expect(
    exchangeDreamboardUserToken({
      apiBaseUrl: "https://api.dreamboard.test",
      clerkAccessToken: "clerk-access-token",
      audience: "dreamboard-api",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    }),
  ).rejects.toThrow("wrong audience");
});
