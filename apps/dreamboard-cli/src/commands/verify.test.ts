import { expect, mock, test } from "bun:test";
const runExactCommitVerification = mock(async () => ({
  projectId: "project-1",
  commitOid: "0123456789abcdef",
  status: "passed" as const,
  hook: true,
  steps: ["worktree", "source-policy", "dependencies", "scenarios"],
  scenarioSummary: {
    passed: 2,
    failed: 0,
    total: 2,
  },
}));

const resolveCommit = mock(async () => "0123456789abcdef");
const resolveConfig = mock(() => ({
  environment: "prod",
  apiBaseUrl: "https://api.example.com",
  webBaseUrl: "https://web.example.com",
  authTokenSource: "none",
  refreshTokenSource: "none",
}));
const { runVerifyCommand } = await import("./verify.ts");

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

test("verify runs exact commit verification without requiring auth", async () => {
  resolveCommit.mockClear();
  resolveConfig.mockClear();
  runExactCommitVerification.mockClear();

  const output = await captureConsoleLog(async () => {
    const result = await runVerifyCommand(
      {
        commit: "HEAD",
        hook: true,
        json: true,
      },
      {
        findGitRoot: async () => "/workspace/project",
        git: { resolveCommit },
        loadGlobalConfig: async () => ({}),
        resolveConfig,
        verify: runExactCommitVerification,
      },
    );
    console.log(JSON.stringify(result));
  });

  expect(resolveCommit).toHaveBeenCalledWith("/workspace/project", "HEAD");
  expect(resolveConfig).toHaveBeenCalledWith({}, expect.anything());
  expect(runExactCommitVerification).toHaveBeenCalledWith({
    projectRoot: "/workspace/project",
    config: expect.objectContaining({ environment: "prod" }),
    commitOid: "0123456789abcdef",
    hook: true,
  });
  expect(JSON.parse(output)).toMatchObject({
    projectId: "project-1",
    commitOid: "0123456789abcdef",
    status: "passed",
    hook: true,
    scenarioSummary: {
      passed: 2,
      failed: 0,
    },
  });
});
