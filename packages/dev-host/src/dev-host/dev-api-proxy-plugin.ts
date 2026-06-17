/**
 * Reverse-proxy plugin for the `dreamboard dev` Vite server.
 *
 * Every `/api/*` request the browser makes is intercepted here, run
 * through the CLI-supplied credential platform when needed, then forwarded to
 * the configured upstream backend with an `Authorization: Bearer <Dreamboard API
 * JWT>` header injected on the wire. The access and refresh tokens never reach
 * the browser.
 *
 * Failure contract:
 * - Permanent refresh failure (stored refresh token invalid) responds
 *   with `401 { error: "session_invalid", message }` so the browser can
 *   show a "Run dreamboard login" overlay instead of surfacing a
 *   confusing upstream 401.
 * - Transient refresh failure responds with a structured proxy failure instead
 *   of exposing credential material to browser code.
 * - Upstream connection failure responds with `502 { error:
 *   "upstream_unavailable", message }`.
 *
 * The proxy is deliberately unaware of the session file / persist
 * endpoint / log relay; those live in `dev-log-relay-plugin.ts`.
 */

import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import consola from "consola";
import type { Plugin } from "vite";
import type { DevHostPlatform, DevHostResolvedBearer } from "./contract.js";

const BROWSER_ORIGIN_HEADER = "X-Dreamboard-Browser-Origin";

export type ResolvedBearer = DevHostResolvedBearer;

export interface DevApiProxyPluginDeps {
  /**
   * Hook point for tests: resolve the bearer token (or a permanent
   * failure) synchronously once per request.
   */
  resolveBearer?: () => Promise<ResolvedBearer>;
  /**
   * Hook point for tests: construct the underlying proxy. Allows
   * injecting an in-memory proxy that talks to a fake upstream.
   */
  createProxy?: (target: string) => DevApiProxy;
}

type DevApiProxy = {
  on(event: "error", listener: ProxyErrorListener): DevApiProxy;
  web(
    req: IncomingMessage,
    res: ServerResponse,
    options?: Record<string, never>,
    callback?: (err?: Error) => void,
  ): void;
  close(): void;
};

type ProxyErrorListener = (
  err: Error,
  req: IncomingMessage,
  res: ServerResponse,
) => void;

export function createDevApiProxyPlugin(options: {
  apiBaseUrl: string;
  platform: DevHostPlatform;
  deps?: DevApiProxyPluginDeps;
}): Plugin {
  const { deps } = options;
  const target = options.apiBaseUrl;

  return {
    name: "dreamboard-dev-api-proxy",
    configureServer(server) {
      const createProxy =
        deps?.createProxy ??
        ((proxyTarget: string) => createStreamingProxy(proxyTarget));

      const proxy = createProxy(target);

      proxy.on("error", (err, _req, res) => {
        consola.debug(`[dev-proxy] upstream error: ${formatUnknown(err)}`);
        if (res instanceof Object && "writeHead" in res && !res.headersSent) {
          respondUpstreamUnavailable(res as ServerResponse, err);
        } else if (res && "destroy" in res) {
          (res as { destroy: () => void }).destroy();
        }
      });

      const resolveBearer =
        deps?.resolveBearer ?? (() => options.platform.resolveBearer());

      // NOTE: we intentionally do NOT mount this middleware on `/api`.
      // Connect-style `middlewares.use(path, handler)` strips the mount
      // prefix from `req.url` before invoking the handler, which would
      // cause the proxy to forward `/sessions/.../status` instead of
      // `/api/sessions/.../status` and the backend would respond 404.
      // Filtering inside the handler keeps the full path intact.
      server.middlewares.use((req, res, next) => {
        if (!req.url || !isApiRequest(req.url)) {
          next();
          return;
        }
        void handleApiRequest({ req, res, proxy, resolveBearer });
      });

      server.httpServer?.once("close", () => {
        proxy.close();
      });
    },
  };
}

async function handleApiRequest(options: {
  req: IncomingMessage;
  res: ServerResponse;
  proxy: DevApiProxy;
  resolveBearer: () => Promise<ResolvedBearer>;
}): Promise<void> {
  const { req, res, proxy, resolveBearer } = options;
  try {
    const bearer = await resolveBearer();
    if (bearer.kind === "permanent_invalid") {
      respondSessionInvalid(res, bearer.message);
      return;
    }

    if (bearer.token) {
      req.headers.authorization = `Bearer ${bearer.token}`;
    } else {
      delete req.headers.authorization;
    }

    proxy.web(req, res, {}, (err) => {
      if (!err) return;
      consola.debug(`[dev-proxy] forward error: ${formatUnknown(err)}`);
      if (!res.headersSent) {
        respondUpstreamUnavailable(res, err);
      }
    });
  } catch (err) {
    consola.debug(`[dev-proxy] pre-forward error: ${formatUnknown(err)}`);
    respondRefreshFailed(res, err);
  }
}

function createStreamingProxy(target: string): DevApiProxy {
  const targetUrl = new URL(target);
  const events = new EventEmitter();
  const activeRequests = new Set<http.ClientRequest>();

  const proxy: DevApiProxy = {
    on(event, listener) {
      events.on(event, listener);
      return proxy;
    },
    web(req, res, _options, callback) {
      const upstreamUrl = new URL(req.url ?? "/", targetUrl);
      const headers = createForwardHeaders(req, targetUrl);

      const client = targetUrl.protocol === "https:" ? https : http;
      const upstreamReq = client.request(
        upstreamUrl,
        {
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          res.writeHead(
            upstreamRes.statusCode ?? 502,
            upstreamRes.statusMessage,
            upstreamRes.headers,
          );
          upstreamRes.pipe(res);
        },
      );

      activeRequests.add(upstreamReq);

      const handleError = (err: Error) => {
        activeRequests.delete(upstreamReq);
        callback?.(err);
        events.emit("error", err, req, res);
      };

      upstreamReq.on("error", handleError);
      upstreamReq.on("close", () => activeRequests.delete(upstreamReq));
      req.on("aborted", () => upstreamReq.destroy());
      req.pipe(upstreamReq);
    },
    close() {
      for (const request of activeRequests) {
        request.destroy();
      }
      activeRequests.clear();
      events.removeAllListeners();
    },
  };

  return proxy;
}

export function createForwardHeaders(
  req: IncomingMessage,
  targetUrl: URL,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  const browserOrigin = isGameplayCapabilityRequest(req.url ?? "")
    ? canonicalizeBrowserOrigin(req.headers.origin)
    : null;

  // Browser requests are same-origin with the dev host. Once the CLI proxies
  // them to the backend, they are server-to-server requests; forwarding the
  // browser Origin from a Cloudflare/LAN host makes backend CORS reject valid
  // dev traffic.
  delete headers.origin;
  deleteHeaderCaseInsensitive(headers, BROWSER_ORIGIN_HEADER);
  delete headers["access-control-request-headers"];
  delete headers["access-control-request-method"];

  headers.host = targetUrl.host;
  headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = targetUrl.protocol.replace(":", "");
  if (browserOrigin) {
    headers[BROWSER_ORIGIN_HEADER] = browserOrigin;
  }

  return headers;
}

function respondSessionInvalid(res: ServerResponse, message: string): void {
  if (res.headersSent) return;
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      error: "session_invalid",
      message,
    }),
  );
}

function respondUpstreamUnavailable(res: ServerResponse, error: unknown): void {
  if (res.headersSent) return;
  res.statusCode = 502;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      error: "upstream_unavailable",
      message: formatUnknown(error),
    }),
  );
}

function respondRefreshFailed(res: ServerResponse, error: unknown): void {
  if (res.headersSent) return;
  res.statusCode = 502;
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      error: "refresh_failed",
      message: formatUnknown(error),
    }),
  );
}

function isApiRequest(url: string): boolean {
  return url === "/api" || url.startsWith("/api/") || url.startsWith("/api?");
}

function isGameplayCapabilityRequest(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url, "http://dreamboard.dev").pathname;
  } catch {
    pathname = url.split("?", 1)[0] ?? "";
  }

  return (
    /^\/api\/sessions\/[^/]+\/players\/[^/]+\/gameplay-capability$/.test(
      pathname,
    ) ||
    /^\/api\/demo\/sessions\/[^/]+\/players\/[^/]+\/gameplay-capability$/.test(
      pathname,
    )
  );
}

function canonicalizeBrowserOrigin(
  origin: string | string[] | undefined,
): string | null {
  if (typeof origin !== "string") return null;
  const rawOrigin = origin.trim();
  if (!rawOrigin || rawOrigin === "null") return null;

  let parsed: URL;
  try {
    parsed = new URL(rawOrigin);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }
  if (parsed.username || parsed.password) {
    return null;
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return null;
  }
  if (
    parsed.hostname !== "localhost" &&
    parsed.hostname.includes("localhost")
  ) {
    return null;
  }
  if (parsed.hostname.startsWith("[") && rawOrigin !== parsed.origin) {
    return null;
  }

  return parsed.origin;
}

function deleteHeaderCaseInsensitive(
  headers: http.OutgoingHttpHeaders,
  headerName: string,
): void {
  const target = headerName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      delete headers[key];
    }
  }
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name || "Unknown error";
  }
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
