import { useEffect, useState, useSyncExternalStore } from "react";
import {
  PERF_MARK_NAMES,
  clearPerfEntries,
  getPerfEntries,
  isPerfEnabled,
  type PerfEntry,
} from "../perf.js";

/**
 * Tier-0 input-latency HUD.
 *
 * Enabled when {@link isPerfEnabled} returns true (dev build or
 * `localStorage.dreamboard.perf = 1`) AND the URL contains `?perf=1`.
 * The explicit query flag keeps the overlay off in the normal dev
 * experience; flip it on for a targeted benchmarking session.
 *
 * Shared by `apps/web` (real game sessions) and `apps/dreamboard-cli`
 * (`dreamboard dev` local host) so both surfaces expose the same HUD
 * against the same `clientActionId`-keyed ring buffer.
 */
const REFRESH_INTERVAL_MS = 500;
const MAX_ROWS = 10;

interface RowStats {
  clientActionId: string;
  totalMs: number | null;
  serverMs: number | null;
  postAckTailMs: number | null;
  liveMs: number | null;
  renderMs: number | null;
  version: number | undefined;
  syncId: number | undefined;
}

function firstMarkMs(entry: PerfEntry, name: string): number | null {
  const mark = entry.marks.find((m) => m.name === name);
  return mark ? mark.timestampMs : null;
}

function deltaMs(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return Math.round((b - a) * 10) / 10;
}

function toRowStats(entry: PerfEntry): RowStats {
  const t0 = firstMarkMs(entry, PERF_MARK_NAMES.T0_CLICK);
  const t2 = firstMarkMs(entry, PERF_MARK_NAMES.T2_HTTP_SENT);
  const t3 = firstMarkMs(entry, PERF_MARK_NAMES.T3_HTTP_RESPONSE);
  const t4 = firstMarkMs(entry, PERF_MARK_NAMES.T4_LIVE_RECEIVED);
  const t7 = firstMarkMs(entry, PERF_MARK_NAMES.T7_STATE_SYNC_RECEIVED);
  const t8 = firstMarkMs(entry, PERF_MARK_NAMES.T8_RENDER_COMMIT);
  return {
    clientActionId: entry.clientActionId,
    totalMs: deltaMs(t0, t8),
    serverMs: deltaMs(t2, t3),
    postAckTailMs: deltaMs(t3, t8),
    liveMs: deltaMs(t3, t4),
    renderMs: deltaMs(t7, t8),
    version: entry.version,
    syncId: entry.syncId,
  };
}

function formatMs(value: number | null): string {
  if (value === null) return "—";
  return `${value.toFixed(1)}ms`;
}

function formatActionId(actionId: string): string {
  return actionId.length > 8 ? `${actionId.slice(0, 8)}…` : actionId;
}

function subscribeToLocation(onStoreChange: () => void): () => void {
  window.addEventListener("popstate", onStoreChange);
  return () => window.removeEventListener("popstate", onStoreChange);
}

function getPerfOverlayEnabled(): boolean {
  return (
    isPerfEnabled() &&
    new URLSearchParams(window.location.search).get("perf") === "1"
  );
}

function getServerPerfOverlayEnabled(): false {
  return false;
}

function usePerfOverlayEnabled(): boolean {
  return useSyncExternalStore(
    subscribeToLocation,
    getPerfOverlayEnabled,
    getServerPerfOverlayEnabled,
  );
}

export const PerfOverlay: React.FC = () => {
  const enabled = usePerfOverlayEnabled();
  const [rows, setRows] = useState<RowStats[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      const entries = getPerfEntries();
      const sliced = entries.slice(-MAX_ROWS).reverse();
      setRows(sliced.map(toRowStats));
    };
    refresh();
    const handle = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-[9999] max-w-[640px] rounded-md border border-slate-700 bg-slate-900/90 p-3 font-mono text-[11px] text-slate-100 shadow-lg backdrop-blur"
      data-testid="perf-overlay"
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="font-bold uppercase tracking-wider text-emerald-300">
          Tier-0 Input Perf
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="rounded border border-slate-600 px-2 py-0.5 text-[10px] uppercase hover:bg-slate-700"
            onClick={() => {
              clearPerfEntries();
              setRows([]);
            }}
          >
            Clear
          </button>
          <button
            type="button"
            className="rounded border border-slate-600 px-2 py-0.5 text-[10px] uppercase hover:bg-slate-700"
            onClick={() => {
              // eslint-disable-next-line no-console
              console.table(getPerfEntries());
            }}
          >
            Dump
          </button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="py-2 text-slate-400">
          No samples yet. Submit an action to populate the HUD.
        </div>
      ) : (
        <table className="w-full border-collapse">
          <thead className="text-slate-400">
            <tr>
              <th className="pr-2 text-left font-semibold">action</th>
              <th className="pr-2 text-right font-semibold">v</th>
              <th className="pr-2 text-right font-semibold">total</th>
              <th className="pr-2 text-right font-semibold">server</th>
              <th className="pr-2 text-right font-semibold">post-ack</th>
              <th className="pr-2 text-right font-semibold">live</th>
              <th className="text-right font-semibold">render</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.clientActionId}
                className="border-t border-slate-800 align-top"
              >
                <td className="pr-2 text-slate-300">
                  {formatActionId(row.clientActionId)}
                </td>
                <td className="pr-2 text-right text-slate-400">
                  {row.version ?? "—"}
                </td>
                <td className="pr-2 text-right text-emerald-200">
                  {formatMs(row.totalMs)}
                </td>
                <td className="pr-2 text-right text-slate-200">
                  {formatMs(row.serverMs)}
                </td>
                <td className="pr-2 text-right text-amber-200">
                  {formatMs(row.postAckTailMs)}
                </td>
                <td className="pr-2 text-right text-slate-200">
                  {formatMs(row.liveMs)}
                </td>
                <td className="text-right text-slate-200">
                  {formatMs(row.renderMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};
