import { describe, expect, test } from "bun:test";
import {
  unifiedSessionSelectors,
  type UnifiedSessionStore,
} from "./unified-session-store.js";

describe("unifiedSessionSelectors", () => {
  test("returns a stable active lifecycle before a session is loaded", () => {
    const idleStore = {
      session: { type: "idle" },
    } as UnifiedSessionStore;

    expect(unifiedSessionSelectors.lifecycle(idleStore)).toBe(
      unifiedSessionSelectors.lifecycle(idleStore),
    );
  });
});
