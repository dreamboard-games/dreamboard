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
    expect(commandPathToId(["auth", "login"])).toBe("auth.login");
    expect(commandPathToId(["auth", "logout"])).toBe("auth.logout");
    expect(commandPathToId(["auth", "status"])).toBe("auth.status");
    expect(commandPathToId(["auth", "git-credential"])).toBe(
      "auth.git_credential",
    );
    expect(commandPathToId(["project", "create"])).toBe("project.create");
    expect(commandPathToId(["project", "clone"])).toBe("project.clone");
    expect(commandPathToId(["project", "status"])).toBe("project.status");
    expect(commandPathToId(["verify"])).toBe("verify");
    expect(commandPathToId(["build"])).toBe("build");
    expect(commandPathToId(["preview"])).toBe("preview");
    expect(commandPathToId(["release", "publish"])).toBe("release.publish");
    expect(commandPathToId(["release", "current"])).toBe("release.current");
  });
});
