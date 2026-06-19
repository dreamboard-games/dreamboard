import { describe, expect, test } from "bun:test";
import {
  commandPathToId,
  consumeMachineOutputMode,
} from "./machine-output.js";

describe("machine output mode", () => {
  test("consumes exactly one machine output flag from argv", () => {
    const argv = ["node", "dreamboard", "auth", "status", "--json"];
    const mode = consumeMachineOutputMode(argv);

    expect(mode?.mode).toBe("json");
    expect(typeof mode?.runId).toBe("string");
    expect(argv).toEqual(["node", "dreamboard", "auth", "status"]);
  });

  test("rejects mutually exclusive machine output flags", () => {
    const argv = [
      "node",
      "dreamboard",
      "status",
      "--json",
      "--json-events",
    ];

    expect(() => consumeMachineOutputMode(argv)).toThrow(
      /Use only one machine output mode/,
    );
  });

  test("maps current commands onto the Phase 8 command ids", () => {
    expect(commandPathToId(["auth", "status"])).toBe("auth.status");
    expect(commandPathToId(["auth", "git-credential"])).toBe(
      "auth.git_credential",
    );
    expect(commandPathToId(["new"])).toBe("project.create");
    expect(commandPathToId(["clone"])).toBe("project.clone");
    expect(commandPathToId(["status"])).toBe("project.status");
    expect(commandPathToId(["compile"])).toBe("build");
    expect(commandPathToId(["sync"])).toBe("verify");
  });
});
