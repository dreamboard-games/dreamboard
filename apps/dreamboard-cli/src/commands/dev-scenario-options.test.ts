import { describe, expect, test } from "bun:test";
import { assertScenarioDevArgumentCompatibility } from "./dev.js";

const defaults = {
  debug: false,
  "new-session": false,
  open: false,
};

describe("dev scenario options", () => {
  test("requires --from-scenario when --at is present", () => {
    expect(() =>
      assertScenarioDevArgumentCompatibility(
        { ...defaults, at: "given:1" } as never,
        null,
      ),
    ).toThrow("--at requires --from-scenario");
  });

  test("uses scenario.setup as the only setup authority", () => {
    for (const conflicting of [
      { resume: "session-1" },
      { seed: "17" },
      { "setup-profile": "quick" },
      { players: "2" },
      { "player-count": "2" },
    ]) {
      expect(() =>
        assertScenarioDevArgumentCompatibility(
          { ...defaults, ...conflicting } as never,
          "test/scenarios/opening.scenario.ts",
        ),
      ).toThrow("reads players, seed, and setup profile from scenario.setup");
    }
  });

  test("accepts a scenario path with an optional checkpoint", () => {
    expect(() =>
      assertScenarioDevArgumentCompatibility(
        { ...defaults, at: "when:0" } as never,
        "test/scenarios/opening.scenario.ts",
      ),
    ).not.toThrow();
  });
});
