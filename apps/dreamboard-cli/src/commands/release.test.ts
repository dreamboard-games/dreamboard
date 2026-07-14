import { expect, mock, test } from "bun:test";

const getCurrentProjectReleaseSdk = mock(async () => ({
  releaseId: "release-1",
  gameRevisionId: "revision-1",
  compiledArtifactId: "artifact-1",
  status: "ACTIVE",
  retentionRef: "refs/dreamboard/releases/release-1",
  createdAt: "2026-06-19T00:00:00Z",
}));

mock.module("../config/resolve.js", () => ({
  resolveConfig: () => ({
    environment: "prod",
    apiBaseUrl: "https://api.example.com",
    webBaseUrl: "https://web.example.com",
    authTokenSource: "none",
    refreshTokenSource: "none",
  }),
  resolveProjectContext: async () => ({
    projectRoot: "/workspace/project",
    projectConfig: {
      schemaVersion: 2,
      projectId: "project-1",
      slug: "project-1",
      projectId: "project-1",
    },
    config: {
      environment: "prod",
      apiBaseUrl: "https://api.example.com",
      webBaseUrl: "https://web.example.com",
      authToken: "token",
      authTokenSource: "global",
      refreshTokenSource: "none",
    },
  }),
}));

mock.module("../flags.js", () => ({
  parseConfigFlags: (args: Record<string, unknown>) => args,
  parseCommitScopedCommandArgs: (
    _commandName: string,
    args: Record<string, unknown>,
  ) => args,
  parseReleasePublishCommandArgs: (args: Record<string, unknown>) => args,
}));

mock.module("@dreamboard-games/cli-core", () => ({
  SystemGit: class {
    async resolveCommit() {
      return "0123456789abcdef";
    }
  },
}));

mock.module("../services/api/index.js", () => ({
  getCurrentProjectReleaseSdk,
  publishProjectReleaseSdk: async () => {
    throw new Error("unexpected publish");
  },
}));

const releaseCommand = (await import("./release.ts")).default;

async function captureConsoleLog(run: () => Promise<void>): Promise<string> {
  const originalLog = console.log;
  let output = "";
  console.log = (...args: unknown[]) => {
    output += `${args.map((arg) => String(arg)).join(" ")}\n`;
  };
  try {
    await run();
    return output;
  } finally {
    console.log = originalLog;
  }
}

test("release current reads the active release from the public API", async () => {
  getCurrentProjectReleaseSdk.mockClear();
  const currentCommand = releaseCommand.subCommands?.current as
    | { run?: (context: { args: unknown }) => Promise<void> }
    | undefined;

  const output = await captureConsoleLog(async () => {
    await currentCommand?.run?.({
      args: {
        json: true,
      },
    });
  });

  expect(getCurrentProjectReleaseSdk).toHaveBeenCalledWith({
    projectId: "project-1",
  });
  expect(JSON.parse(output)).toMatchObject({
    releaseId: "release-1",
    status: "ACTIVE",
    retentionRef: "refs/dreamboard/releases/release-1",
  });
});
