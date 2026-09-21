import { request } from "node:http";
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { WebSocketServer } from "ws";
import { chromium } from "playwright";
import { createDevApiProxyPlugin } from "../src/dev-host/dev-api-proxy-plugin.js";
import { PLUGIN_IFRAME_SANDBOX } from "../src/dev-host/plugin-iframe-policy.js";

let server: ViteDevServer;
let root: string;
let origin: string;
let resolutions = 0;
let gameplayServer: WebSocketServer;
let websocketUrl: string;
const authenticatedTokens: string[] = [];
const credentialPath = "/__dreamboard_dev/gameplay-credential";

beforeAll(async () => {
  gameplayServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) =>
    gameplayServer.once("listening", resolve),
  );
  const gameplayAddress = gameplayServer.address();
  if (typeof gameplayAddress === "string")
    throw new Error("No gameplay TCP address");
  websocketUrl = `ws://127.0.0.1:${gameplayAddress.port}`;
  gameplayServer.on("connection", (socket) => {
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "auth.connect" || frame.type === "auth.refresh") {
        authenticatedTokens.push(frame.credential.token);
        socket.send(
          JSON.stringify({
            type: "auth.accepted",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          }),
        );
      }
    });
  });
  root = await mkdtemp(path.join(os.tmpdir(), "devhost-isolation-"));
  await writeFile(
    path.join(root, "index.html"),
    `<iframe sandbox="${PLUGIN_IFRAME_SANDBOX}" src="/plugin.html"></iframe>`,
  );
  await writeFile(
    path.join(root, "plugin.html"),
    `<script type="module" src="/plugin.js"></script>`,
  );
  await writeFile(
    path.join(root, "plugin.js"),
    `
    addEventListener("message", event => {
      if (event.source !== parent || event.data?.payload?.type !== "runtime.init") return;
      const { protocol, version, channelId } = event.data;
      parent.postMessage({ protocol, version, channelId, sequence: 1, payload: { type: "runtime.ready" } }, "*");
    });
    let parentDenied = false;
    try { void parent.document.body; } catch { parentDenied = true; }
    let credentialDenied = false;
    try { const response = await fetch(${JSON.stringify(credentialPath)}, { method: "POST" }); credentialDenied = !response.ok; }
    catch { credentialDenied = true; }
    parent.postMessage({ parentDenied, credentialDenied }, "*");
  `,
  );
  server = await createServer({
    configFile: false,
    appType: "mpa",
    root,
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      port: 0,
      fs: { allow: [root, path.resolve(import.meta.dirname, "../../..")] },
      headers: { "Access-Control-Allow-Origin": "*" },
    },
    plugins: [
      createDevApiProxyPlugin({
        apiBaseUrl: "http://127.0.0.1:1",
        deps: {
          createProxy: () => ({
            on() {
              return this;
            },
            web(req, res) {
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({
                  path: req.url,
                  authenticated: req.headers.authorization?.startsWith(
                    "Bearer test-access-",
                  ),
                }),
              );
            },
            close() {},
          }),
        },
        platform: {
          resolveBearer: async () => ({
            kind: "ok",
            token: `test-access-${++resolutions}`,
          }),
        },
      }),
    ],
  });
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string")
    throw new Error("No Vite TCP address");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await server?.close();
  gameplayServer?.close();
  await rm(root, { recursive: true, force: true });
});

test("credential endpoint rejects absent, opaque, cross-origin and untrusted-host requests without resolving credentials", async () => {
  const before = resolutions;
  for (const originHeader of [undefined, "null", "https://attacker.test"]) {
    const response = await fetch(`${origin}${credentialPath}`, {
      method: "POST",
      headers: originHeader ? { Origin: originHeader } : {},
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
  expect(await requestWithUntrustedHost(credentialPath, "POST")).toBe(403);
  for (const route of [
    "/api/sessions/test/start",
    "/__dreamboard_dev/session/new",
  ]) {
    const response = await fetch(`${origin}${route}`, {
      method: "POST",
      headers: { Origin: "null" },
    });
    expect(response.status).toBe(403);
  }
  expect(resolutions).toBe(before);
});

test("host API reads and writes pass through after host validation without losing the original path", async () => {
  const read = await fetch(
    `${origin}/api/sessions/test/snapshot?playerId=player-1`,
  );
  expect(await read.json()).toEqual({
    path: "/api/sessions/test/snapshot?playerId=player-1",
    authenticated: true,
  });
  const write = await fetch(`${origin}/api/sessions/test/start`, {
    method: "POST",
    headers: { Origin: origin },
  });
  expect(await write.json()).toEqual({
    path: "/api/sessions/test/start",
    authenticated: true,
  });
  expect(
    await requestWithUntrustedHost("/api/sessions/test/snapshot", "GET"),
  ).toBe(403);
});

test("opaque authored frame cannot read its parent or credentials; the host obtains refreshed access credentials", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      (window as any).isolationProof = new Promise((resolve) => {
        addEventListener("message", (event) => {
          if (event.source === document.querySelector("iframe")?.contentWindow)
            resolve({ ...event.data, origin: event.origin });
        });
      });
    });
    await page.goto(origin);
    const proof = await page.evaluate(() => (window as any).isolationProof);
    expect(proof).toEqual({
      parentDenied: true,
      credentialDenied: true,
      origin: "null",
    });
    const credentials = await page.evaluate(async (credentialPath) => {
      const first = await fetch(credentialPath, { method: "POST" });
      const second = await fetch(credentialPath, { method: "POST" });
      return {
        first: await first.json(),
        second: await second.json(),
        cache: second.headers.get("cache-control"),
        cors: second.headers.get("access-control-allow-origin"),
      };
    }, credentialPath);
    expect(credentials.first.kind).toBe("user");
    expect(credentials.second.token).not.toBe(credentials.first.token);
    expect(credentials.cache).toBe("no-store");
    expect(credentials.cors).toBeNull();
    const bridgeModuleUrl = `/@fs/${path.resolve(import.meta.dirname, "../../ui-host-runtime/src/plugin-bridge.ts")}`;
    await page.evaluate(`(async () => {
      const { PluginBridge } = await import(${JSON.stringify(bridgeModuleUrl)});
      const bridge = new PluginBridge(document.querySelector("iframe"));
      try {
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("Opaque plugin handshake timed out")), 5_000);
          bridge.onPluginMessage("runtime.ready", () => { clearTimeout(timeout); resolve(); });
          bridge.sendInit({ sessionId: "browser-test", players: [] });
        });
      } finally { bridge.disconnect(); }
    })()`);
    const clientModuleUrl = `/@fs/${path.resolve(import.meta.dirname, "../../gameplay-authority-client/src/index.ts")}`;
    await page.evaluate(`(async () => {
      const { connectGameplayAuthority } = await import(${JSON.stringify(clientModuleUrl)});
      const readCredential = async () => (await fetch(${JSON.stringify(credentialPath)}, { method: "POST" })).json();
      const connection = await connectGameplayAuthority({ websocketUrl: ${JSON.stringify(websocketUrl)}, credential: await readCredential(), sessionId: "33333333-3333-4333-8333-333333333333", playerId: "player-1" });
      try { await connection.refresh(await readCredential()); }
      finally { connection.close(); }
    })()`);
    expect(authenticatedTokens).toHaveLength(2);
    expect(authenticatedTokens[1]).not.toBe(authenticatedTokens[0]);
  } finally {
    await browser.close();
  }
}, 30_000);

async function requestWithUntrustedHost(
  route: string,
  method: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      `${origin}${route}`,
      {
        method,
        headers: { Host: "attacker.test", Origin: "http://attacker.test" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
