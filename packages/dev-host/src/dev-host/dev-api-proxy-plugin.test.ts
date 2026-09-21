import { expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { createForwardHeaders } from "./dev-api-proxy-plugin.ts";

test("proxy removes browser origin and replaces the upstream host", () => {
  const headers = createForwardHeaders(
    {
      headers: {
        host: "localhost:5173",
        origin: "http://localhost:5173",
        "x-dreamboard-browser-origin": "https://attacker.test",
      },
    } as IncomingMessage,
    new URL("https://api.dreamboard.test"),
  );
  expect(headers.origin).toBeUndefined();
  expect(headers["x-dreamboard-browser-origin"]).toBeUndefined();
  expect(headers.host).toBe("api.dreamboard.test");
});
