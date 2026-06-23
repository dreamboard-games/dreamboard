import { describe, expect, test } from "bun:test";
import {
  ExitCode,
  commandFailure,
  commandSuccess,
  isUnattendedAction,
  type NextAction,
} from "./command-result.js";

describe("command results", () => {
  test("builds versioned success and failure envelopes", () => {
    expect(commandSuccess("project.status", { clean: true })).toEqual({
      schemaVersion: 2,
      ok: true,
      command: "project.status",
      result: { clean: true },
      nextActions: [],
    });

    expect(
      commandFailure(
        "project.status",
        { title: "Not logged in" },
        ExitCode.Unauthenticated,
        [{ id: "auth.login", environment: "staging", unattended: false }],
      ),
    ).toMatchObject({
      schemaVersion: 2,
      ok: false,
      command: "project.status",
      exitCode: ExitCode.Unauthenticated,
    });
  });

  test("only explicitly allowed actions can be unattended", () => {
    const actions: NextAction[] = [
      { id: "retry", unattended: true },
      {
        id: "git.push_required",
        commitOid: "abc",
        remote: "origin",
        unattended: false,
      },
    ];

    expect(actions.map(isUnattendedAction)).toEqual([true, false]);
  });
});
