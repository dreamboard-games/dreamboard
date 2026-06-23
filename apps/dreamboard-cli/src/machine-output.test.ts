import { describe, expect, test } from "bun:test";
import { ExitCode, commandFailure } from "@dreamboard-games/cli-core";
import {
  commandPathToId,
  consumeMachineOutputMode,
} from "./machine-output.js";
import {
  classifyCliFailure,
  contextualizeCliError,
  toDreamboardApiError,
  type CliOperationContext,
} from "./utils/errors.js";

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

  test("classifies response-less API failures once for schema v2 machine output", () => {
    const apiError = toDreamboardApiError(
      new Error("fetch failed for http://user:pass@localhost:8080/api?token=secret"),
      undefined,
      "Failed to resolve authenticated owner scope",
    );
    const context: CliOperationContext = {
      operationId: "operation-1",
      command: "project.create",
      step: "resolve_identity",
      environment: "local",
      apiBaseUrl: "http://user:pass@localhost:8080/api?token=secret",
      slug: "sushi-go",
      projectId: "project-1",
      targetDir: "/tmp/sushi-go",
      remoteProjectState: "not_started",
      repositoryState: "not_started",
      workspaceState: "not_started",
      gitState: "not_started",
    };
    const classified = classifyCliFailure(
      contextualizeCliError(apiError, context),
    );
    const machineFailure = commandFailure(
      "project.create",
      classified.problem,
      classified.exitCode,
      classified.nextActions,
    );

    expect(machineFailure).toMatchObject({
      schemaVersion: 2,
      ok: false,
      command: "project.create",
      exitCode: ExitCode.Transient,
      problem: {
        type: "urn:dreamboard:problem:transport-error",
        title: "Could not reach the Dreamboard API",
        code: "API_TRANSPORT_ERROR",
        context: {
          step: "resolve_identity",
          environment: "local",
          apiBaseUrl: "http://localhost:8080/api",
          slug: "sushi-go",
          projectId: "project-1",
          remoteProjectState: "not_started",
        },
      },
      nextActions: [{ id: "retry", unattended: true }],
    });
  });

  test("classifies common API status failures through one exit-code table", () => {
    const cases = [
      {
        type: "urn:dreamboard:problem:unauthorized",
        status: 401,
        exitCode: ExitCode.Unauthenticated,
        actionId: "auth.login",
      },
      {
        type: "urn:dreamboard:problem:forbidden",
        status: 403,
        exitCode: ExitCode.Forbidden,
      },
      {
        type: "urn:dreamboard:problem:project-slug-conflict",
        status: 409,
        exitCode: ExitCode.Conflict,
      },
      {
        type: "urn:dreamboard:problem:validation-failed",
        status: 422,
        exitCode: ExitCode.Validation,
      },
      {
        type: "urn:dreamboard:problem:internal-error",
        status: 500,
        exitCode: ExitCode.Transient,
        actionId: "retry",
      },
    ] as const;

    for (const entry of cases) {
      const classified = classifyCliFailure(
        toDreamboardApiError(
          {
            type: entry.type,
            title: "API failure",
            status: entry.status,
            detail: "The API rejected the request.",
          },
          { status: entry.status, statusText: "API failure" },
          "API failure",
        ),
      );

      expect(classified.exitCode).toBe(entry.exitCode);
      if (entry.actionId) {
        expect(classified.nextActions[0]?.id).toBe(entry.actionId);
      }
    }
  });
});
