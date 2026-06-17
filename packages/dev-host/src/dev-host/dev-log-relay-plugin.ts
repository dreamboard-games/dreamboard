import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import consola from "consola";
import type { Plugin } from "vite";
import type { DevHostPlatform } from "./contract.js";
import {
  shouldRelayDevLog,
  type DevDiagnosticsLevel,
  type DevLogEnvelope,
} from "./dev-diagnostics.js";
import type { DreamboardDevRuntimeConfig } from "./dev-runtime-config.js";
import type { ActiveSession } from "./dev-host-storage.js";

const STALE_DEV_SESSION_RESET_NOTICE =
  "Resetting disposable dev session because the previous session was created for a stale contract artifact.";

export function createDevLogRelayPlugin(options: {
  sessionFilePath: string;
  runtimeConfig: DreamboardDevRuntimeConfig;
  apiBaseUrl: string;
  platform: DevHostPlatform;
  diagnosticsLevel: DevDiagnosticsLevel;
}): Plugin {
  return {
    name: "dreamboard-dev-log-relay",
    configureServer(server) {
      server.middlewares.use("/__dreamboard_dev/log", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "Method not allowed" }));
          return;
        }

        const chunks: Buffer[] = [];
        req.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        req.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const payload = JSON.parse(body) as Partial<DevLogEnvelope>;
            const normalizedPayload = {
              source: coerceLogSource(payload.source),
              level: coerceLogLevel(payload.level),
              message:
                typeof payload.message === "string"
                  ? payload.message
                  : "Missing dev log message",
            } satisfies DevLogEnvelope;
            if (
              shouldRelayDevLog(options.diagnosticsLevel, normalizedPayload)
            ) {
              relayDevLog(normalizedPayload);
            }
            res.statusCode = 204;
            res.end();
          } catch (error) {
            consola.warn(
              `[dev-host] Failed to decode browser log payload: ${formatUnknown(error)}`,
            );
            res.statusCode = 400;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Invalid dev log payload" }));
          }
        });
      });

      server.middlewares.use(
        "/__dreamboard_dev/session/snapshot",
        createSnapshotSessionHandler({
          sessionFilePath: options.sessionFilePath,
          runtimeConfig: options.runtimeConfig,
          apiBaseUrl: options.apiBaseUrl,
          platform: options.platform,
        }),
      );
      server.middlewares.use(
        "/__dreamboard_dev/session/new",
        createNewSessionHandler({
          sessionFilePath: options.sessionFilePath,
          runtimeConfig: options.runtimeConfig,
          apiBaseUrl: options.apiBaseUrl,
          platform: options.platform,
        }),
      );
      server.middlewares.use(
        "/__dreamboard_dev/session/start",
        createStartSessionHandler({
          sessionFilePath: options.sessionFilePath,
          runtimeConfig: options.runtimeConfig,
          apiBaseUrl: options.apiBaseUrl,
          platform: options.platform,
        }),
      );
    },
  };
}

export function createSnapshotSessionHandler(options: {
  sessionFilePath: string;
  runtimeConfig: DreamboardDevRuntimeConfig;
  apiBaseUrl: string;
  platform: DevHostPlatform;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleSnapshotSessionRequest(req, res, options);
  };
}

export function createNewSessionHandler(options: {
  sessionFilePath: string;
  runtimeConfig: DreamboardDevRuntimeConfig;
  apiBaseUrl: string;
  platform: DevHostPlatform;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleNewSessionRequest(req, res, options);
  };
}

export function createStartSessionHandler(options: {
  sessionFilePath: string;
  runtimeConfig: DreamboardDevRuntimeConfig;
  apiBaseUrl: string;
  platform: DevHostPlatform;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handleStartSessionRequest(req, res, options);
  };
}

async function handleSnapshotSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    sessionFilePath: string;
    runtimeConfig: DreamboardDevRuntimeConfig;
    apiBaseUrl: string;
    platform: DevHostPlatform;
  },
): Promise<void> {
  if (req.method !== "GET") {
    respondJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    let session = await loadCurrentSession(options);
    const requestedPlayerId = extractQueryParam(req, "playerId");
    let snapshot: unknown;
    try {
      snapshot = await fetchBackendJson(
        options,
        appendQuery(`/api/sessions/${session.sessionId}/snapshot`, {
          playerId: requestedPlayerId,
        }),
      );
    } catch (error) {
      if (!isStaleContractArtifactError(error)) {
        throw error;
      }
      session = await resetDisposableSessionPointer(options);
      snapshot = await fetchBackendJson(
        options,
        appendQuery(`/api/sessions/${session.sessionId}/snapshot`, {
          playerId: requestedPlayerId,
        }),
      );
    }
    if (
      options.runtimeConfig.autoStartGame &&
      isStartableLobbySnapshot(snapshot)
    ) {
      snapshot = await fetchBackendJson(
        options,
        `/api/sessions/${session.sessionId}/start`,
        { method: "POST" },
      );
      if (requestedPlayerId) {
        snapshot = await fetchBackendJson(
          options,
          appendQuery(`/api/sessions/${session.sessionId}/snapshot`, {
            playerId: requestedPlayerId,
          }),
        );
      }
      await persistSessionId(options.sessionFilePath, session.sessionId);
    }
    respondJson(res, 200, attachLocalSeed(snapshot, session.seed ?? null));
  } catch (error) {
    respondJson(res, statusForError(error), { error: formatUnknown(error) });
  }
}

async function handleNewSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    sessionFilePath: string;
    runtimeConfig: DreamboardDevRuntimeConfig;
    apiBaseUrl: string;
    platform: DevHostPlatform;
  },
): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const seed = Number.parseInt(String(body.seed ?? ""), 10);
    if (!Number.isSafeInteger(seed)) {
      throw new Error("Seed must be a safe integer.");
    }
    const created = await fetchBackendJson(
      options,
      `/api/games/${options.runtimeConfig.gameId}/sessions`,
      {
        method: "POST",
        body: {
          compiledResultId: options.runtimeConfig.compiledResultId,
          seed,
          playerCount: options.runtimeConfig.playerCount,
          autoAssignSeats: true,
          setupProfileId: options.runtimeConfig.setupProfileId ?? undefined,
        },
      },
    );
    const sessionId = requireString(
      (created as { sessionId?: unknown }).sessionId,
      "sessionId",
    );
    let snapshot = await fetchBackendJson(
      options,
      `/api/sessions/${sessionId}/snapshot`,
    );
    if (
      options.runtimeConfig.autoStartGame &&
      isStartableLobbySnapshot(snapshot)
    ) {
      snapshot = await fetchBackendJson(
        options,
        `/api/sessions/${sessionId}/start`,
        {
          method: "POST",
        },
      );
    }
    await persistSessionId(options.sessionFilePath, sessionId);
    respondJson(res, 200, attachLocalSeed(snapshot, seed));
  } catch (error) {
    respondJson(res, statusForError(error), { error: formatUnknown(error) });
  }
}

async function handleStartSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    sessionFilePath: string;
    runtimeConfig: DreamboardDevRuntimeConfig;
    apiBaseUrl: string;
    platform: DevHostPlatform;
  },
): Promise<void> {
  if (req.method !== "POST") {
    respondJson(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    let session = await loadCurrentSession(options);
    let snapshot: unknown;
    try {
      snapshot = await fetchBackendJson(
        options,
        `/api/sessions/${session.sessionId}/start`,
        { method: "POST" },
      );
    } catch (error) {
      if (!isStaleContractArtifactError(error)) {
        throw error;
      }
      session = await resetDisposableSessionPointer(options);
      snapshot = await fetchBackendJson(
        options,
        `/api/sessions/${session.sessionId}/start`,
        { method: "POST" },
      );
    }
    await persistSessionId(options.sessionFilePath, session.sessionId);
    respondJson(res, 200, attachLocalSeed(snapshot, session.seed ?? null));
  } catch (error) {
    respondJson(res, statusForError(error), { error: formatUnknown(error) });
  }
}

async function readJsonBody(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required field: ${field}`);
  }
  return value;
}

function extractQueryParam(req: IncomingMessage, name: string): string | null {
  const rawUrl = req.url ?? "";
  const value = new URL(rawUrl, "http://dreamboard.local").searchParams.get(
    name,
  );
  return value?.trim() || null;
}

function appendQuery(
  path: string,
  query: Record<string, string | null | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value) {
      params.set(key, value);
    }
  }
  const serialized = params.toString();
  return serialized ? `${path}?${serialized}` : path;
}

async function loadCurrentSession(options: {
  sessionFilePath: string;
  runtimeConfig: DreamboardDevRuntimeConfig;
}): Promise<ActiveSession> {
  if (!(await pathExists(options.sessionFilePath))) {
    return options.runtimeConfig.initialSession;
  }

  const payload = JSON.parse(
    await readFile(options.sessionFilePath, "utf8"),
  ) as unknown;
  const session = parsePersistedSessionPointer(payload, options.runtimeConfig);
  if (!session) {
    throw new Error("Session file did not contain a valid session pointer.");
  }
  return session;
}

async function persistSessionId(
  sessionFilePath: string,
  sessionId: string,
): Promise<void> {
  await writeFile(
    sessionFilePath,
    `${JSON.stringify({ sessionId }, null, 2)}\n`,
    "utf8",
  );
}

async function resetDisposableSessionPointer(options: {
  sessionFilePath: string;
  runtimeConfig: DreamboardDevRuntimeConfig;
}): Promise<ActiveSession> {
  await unlink(options.sessionFilePath).catch(() => undefined);
  consola.info(STALE_DEV_SESSION_RESET_NOTICE);
  return options.runtimeConfig.initialSession;
}

async function fetchBackendJson(
  connection: {
    apiBaseUrl: string;
    platform: DevHostPlatform;
  },
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: Record<string, unknown>;
  } = {},
): Promise<unknown> {
  const bearer = await connection.platform.resolveBearer();
  if (bearer.kind === "permanent_invalid") {
    throw new HttpError(401, bearer.message);
  }

  const response = await fetch(`${connection.apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(bearer.token ? { authorization: `Bearer ${bearer.token}` } : {}),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new HttpError(
      response.status,
      text || `Backend request failed with ${response.status}`,
    );
  }
  return response.json();
}

function attachLocalSeed(snapshot: unknown, seed: number | null): unknown {
  if (!snapshot || typeof snapshot !== "object") {
    return snapshot;
  }
  const context = (snapshot as { context?: unknown }).context;
  if (!context || typeof context !== "object") {
    return snapshot;
  }
  return {
    ...(snapshot as Record<string, unknown>),
    context: {
      ...(context as Record<string, unknown>),
      seed,
    },
  };
}

function isStartableLobbySnapshot(snapshot: unknown): boolean {
  if (!snapshot || typeof snapshot !== "object") {
    return false;
  }
  const context = (snapshot as { context?: { phase?: unknown } }).context;
  const lobby = (snapshot as { lobby?: { canStart?: unknown } }).lobby;
  return context?.phase === "lobby" && lobby?.canStart === true;
}

function respondJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

function statusForError(error: unknown): number {
  return error instanceof HttpError ? error.statusCode : 500;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isStaleContractArtifactError(error: unknown): boolean {
  const code = getObjectStringProperty(error, "code");
  if (code === "STALE_CONTRACT_ARTIFACT") {
    return true;
  }
  const name = getObjectStringProperty(error, "name");
  if (name === "StaleContractArtifactError") {
    return true;
  }
  const message = getObjectStringProperty(error, "message");
  return message
    ? message.includes("STALE_CONTRACT_ARTIFACT") ||
        message.includes("StaleContractArtifactError") ||
        message.toLowerCase().includes("stale contract artifact")
    : false;
}

function getObjectStringProperty(
  value: unknown,
  property: string,
): string | undefined {
  return value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>)[property] === "string"
    ? ((value as Record<string, unknown>)[property] as string)
    : undefined;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function parsePersistedSessionPointer(
  value: unknown,
  runtimeConfig: DreamboardDevRuntimeConfig,
): DreamboardDevRuntimeConfig["initialSession"] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const sessionId = (value as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return null;
  }
  return {
    sessionId,
    shortCode: "Unknown",
    gameId: runtimeConfig.gameId,
    seed: null,
  };
}

function relayDevLog(payload: DevLogEnvelope): void {
  const formatted = `[dev:${payload.source}] ${payload.message}`;
  switch (payload.level) {
    case "error":
      consola.error(formatted);
      break;
    case "warn":
      consola.warn(formatted);
      break;
    case "info":
      consola.info(formatted);
      break;
    default:
      consola.log(formatted);
      break;
  }
}

function coerceLogSource(value: unknown): DevLogEnvelope["source"] {
  return value === "host" || value === "plugin" || value === "sse"
    ? value
    : "host";
}

function coerceLogLevel(value: unknown): DevLogEnvelope["level"] {
  return value === "warn" ||
    value === "error" ||
    value === "info" ||
    value === "log"
    ? value
    : "log";
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
