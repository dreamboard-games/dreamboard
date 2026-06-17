import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { createForwardHeaders } from "./dev-api-proxy-plugin.ts";

function request(
  url: string,
  headers: IncomingMessage["headers"],
): IncomingMessage {
  return {
    url,
    headers,
  } as IncomingMessage;
}

const targetUrl = new URL("https://api.dreamboard.test");

test("forwards canonical browser origin only for gameplay capability requests", () => {
  const headers = createForwardHeaders(
    request("/api/sessions/session-1/players/player-1/gameplay-capability", {
      host: "localhost:5173",
      origin: "HTTP://LOCALHOST:5173/",
      "x-dreamboard-browser-origin": "https://attacker.test",
    }),
    targetUrl,
  );

  expect(headers.origin).toBeUndefined();
  expect(headers["x-dreamboard-browser-origin"]).toBeUndefined();
  expect(headers["X-Dreamboard-Browser-Origin"]).toBe("http://localhost:5173");
});

test("forwards canonical browser origin for demo gameplay capability requests", () => {
  const headers = createForwardHeaders(
    request(
      "/api/demo/sessions/session-1/players/player-1/gameplay-capability?trace=1",
      {
        host: "localhost:5173",
        origin: "https://Tunnel-Macbook.Dreamboard.Games",
      },
    ),
    targetUrl,
  );

  expect(headers.origin).toBeUndefined();
  expect(headers["X-Dreamboard-Browser-Origin"]).toBe(
    "https://tunnel-macbook.dreamboard.games",
  );
});

test("does not forward browser origin header for unrelated api requests", () => {
  const headers = createForwardHeaders(
    request("/api/sessions/session-1/snapshot", {
      host: "localhost:5173",
      origin: "https://devhost.example.test",
      "X-Dreamboard-Browser-Origin": "https://attacker.test",
    }),
    targetUrl,
  );

  expect(headers.origin).toBeUndefined();
  expect(headers["X-Dreamboard-Browser-Origin"]).toBeUndefined();
});

test("does not set browser origin header for invalid capability origins", () => {
  for (const origin of [
    "null",
    "ftp://localhost:5173",
    "https://example.test/path",
    "https://user@example.test",
    "http://localhost.evil.test:5173",
    "http://[0:0:0:0:0:0:0:1]:5173",
  ]) {
    const headers = createForwardHeaders(
      request("/api/sessions/session-1/players/player-1/gameplay-capability", {
        host: "localhost:5173",
        origin,
        "x-dreamboard-browser-origin": "https://attacker.test",
      }),
      targetUrl,
    );

    expect(headers.origin).toBeUndefined();
    expect(headers["x-dreamboard-browser-origin"]).toBeUndefined();
    expect(headers["X-Dreamboard-Browser-Origin"]).toBeUndefined();
  }
});
