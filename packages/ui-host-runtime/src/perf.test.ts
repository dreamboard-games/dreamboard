import { afterEach, describe, expect, test } from "bun:test";
import {
  PERF_MARK_NAMES,
  clearPerfEntries,
  correlateSyncId,
  correlateVersion,
  getPerfReceipts,
  recordMark,
} from "./perf.js";

const originalWindow = globalThis.window;

describe("perf receipts", () => {
  afterEach(() => {
    clearPerfEntries();
    if (originalWindow === undefined) {
      Reflect.deleteProperty(globalThis, "window");
    } else {
      (globalThis as typeof globalThis & { window?: unknown }).window =
        originalWindow;
    }
  });

  test("projects stable user visible timing metrics from submit marks", () => {
    installPerfWindow();

    recordMark("client-action", PERF_MARK_NAMES.T0_CLICK, {
      timestampMs: 1_000,
    });
    recordMark("client-action", PERF_MARK_NAMES.T2_HTTP_SENT, {
      timestampMs: 1_020,
    });
    recordMark("client-action", PERF_MARK_NAMES.T3_HTTP_RESPONSE, {
      timestampMs: 1_090,
    });
    recordMark("client-action", PERF_MARK_NAMES.T3B_RESPONSE_APPLIED, {
      timestampMs: 1_105,
    });
    recordMark("client-action", PERF_MARK_NAMES.T4_LIVE_RECEIVED, {
      timestampMs: 1_230,
    });
    recordMark("client-action", PERF_MARK_NAMES.T5_STORE_APPLIED, {
      timestampMs: 1_245,
    });
    recordMark("client-action", PERF_MARK_NAMES.T8_RENDER_COMMIT, {
      timestampMs: 1_280,
    });
    correlateVersion("client-action", 4);
    correlateSyncId("client-action", 9);

    expect(getPerfReceipts()).toEqual([
      {
        clientActionId: "client-action",
        version: 4,
        syncId: 9,
        metrics: {
          action_submitter_projection_visible_ms: 105,
          action_pending_durability_ms: 125,
          action_durable_confirmation_ms: 230,
          action_other_player_visible_ms: 245,
          action_render_committed_ms: 280,
          action_server_response_ms: 70,
        },
      },
    ]);
  });
});

function installPerfWindow(): void {
  (globalThis as typeof globalThis & { window?: unknown }).window = {
    localStorage: {
      getItem(key: string) {
        return key === "dreamboard.perf" ? "1" : null;
      },
    } as Storage,
  } as unknown as Window & typeof globalThis;
}
