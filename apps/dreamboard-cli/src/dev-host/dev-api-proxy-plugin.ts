/**
 * Reverse-proxy plugin for the `dreamboard dev` Vite server.
 *
 * Every `/api/*` request the browser makes is intercepted here, run
 * through the Clerk OAuth refresh flow when needed, then forwarded to the configured upstream
 * backend with an `Authorization: Bearer <fresh-token>` header injected
 * on the wire. The access and refresh tokens never reach the browser.
 *
 * Failure contract:
 * - Permanent refresh failure (stored refresh token invalid) responds
 *   with `401 { error: "session_invalid", message }` so the browser can
 *   show a "Run dreamboard login" overlay instead of surfacing a
 *   confusing upstream 401.
 * - Transient refresh failure (network blip) falls back to the snapshot
 *   access token in `ResolvedConfig` when we still have one - this lets
 *   a short outage degrade to "existing token" behavior instead of
 *   blocking the iframe outright.
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
import {
  getAuthTokenExpiry,
  refreshResolvedAuthSession,
} from "../config/resolve.js";
import { resolveLocalHarnessAccessToken } from "../config/local-harness-auth.js";
import type { ResolvedConfig } from "../types.js";

export type ResolvedBearerOk = {
  readonly kind: "ok";
  readonly token: string | null;
};
export type ResolvedBearerPermanentFailure = {
  readonly kind: "permanent_invalid";
  readonly message: string;
};
export type ResolvedBearer = ResolvedBearerOk | ResolvedBearerPermanentFailure;

export interface DevApiProxyPluginDeps {
  /**
   * Hook point for tests: resolve the bearer token (or a permanent
   * failure) synchronously once per request.
   */
  resolveBearer?: (config: ResolvedConfig) => Promise<ResolvedBearer>;
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
  config: ResolvedConfig;
  deps?: DevApiProxyPluginDeps;
}): Plugin {
  const { config, deps } = options;
  const target = config.apiBaseUrl;

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

      const resolveBearer = deps?.resolveBearer ?? resolveDevBearer;

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
        void handleApiRequest({ req, res, config, proxy, resolveBearer });
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
  config: ResolvedConfig;
  proxy: DevApiProxy;
  resolveBearer: (config: ResolvedConfig) => Promise<ResolvedBearer>;
}): Promise<void> {
  const { req, res, config, proxy, resolveBearer } = options;
  try {
    const bearer = await resolveBearer(config);
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

function createForwardHeaders(
  req: IncomingMessage,
  targetUrl: URL,
): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };

  // Browser requests are same-origin with the dev host. Once the CLI proxies
  // them to the backend, they are server-to-server requests; forwarding the
  // browser Origin from a Cloudflare/LAN host makes backend CORS reject valid
  // dev traffic.
  delete headers.origin;
  delete headers["access-control-request-headers"];
  delete headers["access-control-request-method"];

  headers.host = targetUrl.host;
  headers["x-forwarded-host"] = req.headers.host;
  headers["x-forwarded-proto"] = targetUrl.protocol.replace(":", "");

  return headers;
}

export async function resolveDevBearer(
  config: ResolvedConfig,
): Promise<ResolvedBearer> {
  const localHarnessToken = resolveLocalHarnessAccessToken(config);
  if (localHarnessToken) {
    return { kind: "ok", token: localHarnessToken };
  }

  // Env/flag-provided tokens are not owned by `CredentialStore` and must
  // not be rotated. Forward them as-is.
  if (!usesStoredSession(config)) {
    return { kind: "ok", token: config.authToken ?? null };
  }

  const expiry = getAuthTokenExpiry(config.authToken);
  const isExpired = expiry !== null && expiry.getTime() <= Date.now();
  if (!isExpired) {
    return { kind: "ok", token: config.authToken ?? null };
  }

  if (!config.refreshToken) {
    return {
      kind: "permanent_invalid",
      message:
        "Stored Dreamboard session is expired or invalid. Run `dreamboard login` to authenticate again.",
    };
  }

  const refreshed = await refreshResolvedAuthSession(config);
  return {
    kind: "ok",
    token: refreshed?.accessToken ?? config.authToken ?? null,
  };
}

function usesStoredSession(config: ResolvedConfig): boolean {
  return (
    config.authTokenSource === "global" &&
    config.refreshTokenSource === "global"
  );
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
