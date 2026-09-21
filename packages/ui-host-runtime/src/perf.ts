/**
 * Dev-only Tier-0 input-latency perf instrumentation.
 *
 * This module is used by the web host (and re-exported for the dev HUD)
 * to record `t0..t8` timing marks for each submitted interaction,
 * keyed by the client-minted `clientActionId`. It is deliberately
 * stateless across page reloads (in-memory ring buffer on `window`)
 * and gated behind `import.meta.env.DEV` or
 * `localStorage.getItem("dreamboard.perf") === "1"` so prod users
 * pay nothing.
 *
 * Design notes
 * - The plugin iframe lives in a separate window/performance context,
 *   so plugin-side `performance.mark` entries are not reachable from
 *   the host. We work around this by shipping plugin-minted `Date.now()`
 *   timestamps across `postMessage` boundaries and recording them on
 *   the host-side buffer keyed by `clientActionId`. Date.now() is used
 *   (not `performance.now()`) because it shares a wall-clock base
 *   across the iframe and the host.
 * - Live `gameplay.updated` messages do not carry `clientActionId`; they
 *   carry `version`. The host records a `version -> actionId` mapping
 *   on `t3_http_response` (when the POST action submit response comes back
 *   with `version`) so downstream marks (`t4_live_received`,
 *   `t5_store_applied`, `t6_state_sync_posted`) can be stitched by
 *   version. Similarly `syncId -> actionId` is captured at `t5` so
 *   plugin-side state-ack / state-rendered callbacks (which carry
 *   `syncId`) can resolve back to the originating action.
 */

export const PERF_MARK_NAMES = {
  T0_CLICK: "t0_click",
  T1_HOST_RECEIVED: "t1_host_received",
  T2_HTTP_SENT: "t2_http_sent",
  T3_HTTP_RESPONSE: "t3_http_response",
  /**
   * Fires when the store applies the submitter's gameplay snapshot
   * directly from the HTTP response (the Phase B2 eager-apply path).
   * Sits between `t3_http_response` and `t5_store_applied`; its delta
   * vs `t3_http_response` measures pure apply-in-store cost and its
   * delta vs `t4_live_received` tells us how much Live tail the eager
   * apply cuts off for the submitter.
   */
  T3B_RESPONSE_APPLIED: "t3b_response_applied",
  T4_LIVE_RECEIVED: "t4_live_received",
  T5_STORE_APPLIED: "t5_store_applied",
  T6_STATE_SYNC_POSTED: "t6_state_sync_posted",
  T7_STATE_SYNC_RECEIVED: "t7_state_sync_received",
  T8_RENDER_COMMIT: "t8_render_commit",
} as const;

export type PerfMarkName =
  (typeof PERF_MARK_NAMES)[keyof typeof PERF_MARK_NAMES];

export interface PerfMarkRecord {
  name: string;
  timestampMs: number;
  extra?: Record<string, unknown>;
}

export interface PerfEntry {
  clientActionId: string;
  version?: number;
  syncId?: number;
  createdAtMs: number;
  marks: PerfMarkRecord[];
}

export interface PerfReceiptMetrics {
  action_submitter_projection_visible_ms?: number;
  action_pending_durability_ms?: number;
  action_durable_confirmation_ms?: number;
  action_other_player_visible_ms?: number;
  action_render_committed_ms?: number;
  action_server_response_ms?: number;
}

export interface PerfReceipt {
  clientActionId: string;
  version?: number;
  syncId?: number;
  metrics: PerfReceiptMetrics;
}

interface PerfBuffer {
  entries: PerfEntry[];
  versionIndex: Map<number, string>;
  syncIdIndex: Map<number, string>;
}

const GLOBAL_KEY = "__dreamboardPerf__";
const DUMP_KEY = "__dreamboardPerfDump__";
const MAX_ENTRIES = 50;

type PerfGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: PerfBuffer;
  [DUMP_KEY]?: () => PerfEntry[];
};

function getBuffer(): PerfBuffer | null {
  if (typeof globalThis === "undefined") {
    return null;
  }
  const scope = globalThis as PerfGlobal;
  const existing = scope[GLOBAL_KEY];
  if (existing) {
    return existing;
  }
  const buffer: PerfBuffer = {
    entries: [],
    versionIndex: new Map(),
    syncIdIndex: new Map(),
  };
  scope[GLOBAL_KEY] = buffer;
  scope[DUMP_KEY] = () => buffer.entries.slice();
  return buffer;
}

/**
 * Perf marks + HUD are off by default in prod. Enabled in dev builds
 * or when a maintainer opts in via `localStorage.dreamboard.perf = 1`.
 */
export function isPerfEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
    if (env?.DEV) {
      return true;
    }
  } catch {
    // import.meta may be unavailable in non-Vite contexts; fall through
  }
  try {
    return window.localStorage.getItem("dreamboard.perf") === "1";
  } catch {
    return false;
  }
}

function nowMs(): number {
  return Date.now();
}

function findOrCreateEntry(
  buffer: PerfBuffer,
  clientActionId: string,
): PerfEntry {
  const existing = buffer.entries.find(
    (entry) => entry.clientActionId === clientActionId,
  );
  if (existing) {
    return existing;
  }
  const created: PerfEntry = {
    clientActionId,
    createdAtMs: nowMs(),
    marks: [],
  };
  buffer.entries.push(created);
  while (buffer.entries.length > MAX_ENTRIES) {
    const evicted = buffer.entries.shift();
    if (!evicted) break;
    if (evicted.version !== undefined) {
      buffer.versionIndex.delete(evicted.version);
    }
    if (evicted.syncId !== undefined) {
      buffer.syncIdIndex.delete(evicted.syncId);
    }
  }
  return created;
}

export interface RecordMarkOptions {
  timestampMs?: number;
  extra?: Record<string, unknown>;
}

/**
 * Record a perf mark against a `clientActionId`. No-ops silently when
 * perf is disabled or the runtime has no usable window/globalThis.
 */
export function recordMark(
  clientActionId: string | undefined | null,
  name: string,
  options: RecordMarkOptions = {},
): void {
  if (!clientActionId) return;
  if (!isPerfEnabled()) return;
  const buffer = getBuffer();
  if (!buffer) return;

  const timestampMs = options.timestampMs ?? nowMs();
  const entry = findOrCreateEntry(buffer, clientActionId);
  entry.marks.push({
    name,
    timestampMs,
    extra: options.extra,
  });

  if (
    typeof performance !== "undefined" &&
    typeof performance.mark === "function"
  ) {
    try {
      performance.mark(`dreamboard.${name}.${clientActionId}`, {
        detail: { clientActionId, ...options.extra },
      });
    } catch {
      // performance.mark detail arg not supported in older browsers; ignore
    }
  }
}

/**
 * Associate the server-returned `version` (from SubmitInputResponse)
 * with a client-minted actionId so downstream Live marks keyed by
 * `version` can resolve back to the original action.
 */
export function correlateVersion(
  clientActionId: string,
  version: number,
): void {
  if (!isPerfEnabled()) return;
  const buffer = getBuffer();
  if (!buffer) return;
  const entry = findOrCreateEntry(buffer, clientActionId);
  entry.version = version;
  buffer.versionIndex.set(version, clientActionId);
}

/**
 * Associate the local `syncId` assigned when the store applies the
 * gameplay.updated with a clientActionId, so plugin-side state-ack /
 * state-rendered callbacks (which carry syncId rather than actionId)
 * can resolve back to the original action.
 */
export function correlateSyncId(clientActionId: string, syncId: number): void {
  if (!isPerfEnabled()) return;
  const buffer = getBuffer();
  if (!buffer) return;
  const entry = findOrCreateEntry(buffer, clientActionId);
  entry.syncId = syncId;
  buffer.syncIdIndex.set(syncId, clientActionId);
}

export function findActionIdByVersion(version: number): string | undefined {
  const buffer = getBuffer();
  return buffer?.versionIndex.get(version);
}

export function findActionIdBySyncId(syncId: number): string | undefined {
  const buffer = getBuffer();
  return buffer?.syncIdIndex.get(syncId);
}

export function getPerfEntries(): PerfEntry[] {
  const buffer = getBuffer();
  return buffer ? buffer.entries.slice() : [];
}

export function getPerfReceipts(): PerfReceipt[] {
  return getPerfEntries().map((entry) => ({
    clientActionId: entry.clientActionId,
    version: entry.version,
    syncId: entry.syncId,
    metrics: {
      action_submitter_projection_visible_ms: deltaFor(
        entry,
        PERF_MARK_NAMES.T0_CLICK,
        PERF_MARK_NAMES.T3B_RESPONSE_APPLIED,
      ),
      action_pending_durability_ms: deltaFor(
        entry,
        PERF_MARK_NAMES.T3B_RESPONSE_APPLIED,
        PERF_MARK_NAMES.T4_LIVE_RECEIVED,
      ),
      action_durable_confirmation_ms: deltaFor(
        entry,
        PERF_MARK_NAMES.T0_CLICK,
        PERF_MARK_NAMES.T4_LIVE_RECEIVED,
      ),
      action_other_player_visible_ms: deltaFor(
        entry,
        PERF_MARK_NAMES.T0_CLICK,
        PERF_MARK_NAMES.T5_STORE_APPLIED,
      ),
      action_render_committed_ms: deltaFor(
        entry,
        PERF_MARK_NAMES.T0_CLICK,
        PERF_MARK_NAMES.T8_RENDER_COMMIT,
      ),
      action_server_response_ms: deltaFor(
        entry,
        PERF_MARK_NAMES.T2_HTTP_SENT,
        PERF_MARK_NAMES.T3_HTTP_RESPONSE,
      ),
    },
  }));
}

/** Drop every recorded entry; used by tests and the HUD "Clear" action. */
export function clearPerfEntries(): void {
  const buffer = getBuffer();
  if (!buffer) return;
  buffer.entries = [];
  buffer.versionIndex.clear();
  buffer.syncIdIndex.clear();
}

function firstMarkMs(entry: PerfEntry, name: string): number | undefined {
  return entry.marks.find((mark) => mark.name === name)?.timestampMs;
}

function deltaFor(
  entry: PerfEntry,
  startName: string,
  endName: string,
): number | undefined {
  const start = firstMarkMs(entry, startName);
  const end = firstMarkMs(entry, endName);
  if (start === undefined || end === undefined) return undefined;
  return Math.round((end - start) * 10) / 10;
}
