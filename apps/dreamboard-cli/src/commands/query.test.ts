import { afterAll, expect, mock, test } from "bun:test";

const queryWorkshopRulebook = mock(async () => ({
  data: {
    ruleText:
      "Dreamboard sample rules text excerpt. Top-three fallback succeeded.",
  },
  error: null,
  response: { status: 200 },
}));
const loadGlobalConfig = mock(async () => ({
  authToken: "test-token",
  environment: "local",
}));
const configureClient = mock(async () => undefined);
const requireAuth = mock(() => undefined);
const consoleLog = mock(() => undefined);
const actualFlags = await import("../flags.js");

mock.module("@dreamboard-games/api-client", () => ({
  queryWorkshopRulebook,
  getLatestCompiledResult: mock(async () => ({
    data: null,
  })),
}));

mock.module("../config/global-config.js", () => ({
  loadGlobalConfig,
}));

mock.module("../config/resolve.js", () => ({
  resolveConfig: () => ({
    apiBaseUrl: "http://127.0.0.1:8080",
    authToken: "test-token",
  }),
  resolveProjectContext: async () => {
    throw new Error("Unexpected resolveProjectContext call in query test");
  },
  configureClient,
  requireAuth,
}));

mock.module("../flags.js", () => ({
  ...actualFlags,
  parseQueryCommandArgs: (args: Record<string, unknown>) => args,
}));

const originalConsoleLog = console.log;
console.log = consoleLog;

afterAll(() => {
  console.log = originalConsoleLog;
});

const queryCommand = (await import("./query.ts")).default;

test("query command fetches rulebook text from the backend", async () => {
  await queryCommand.run({
    args: {
      title: "Chess",
      env: "local",
    },
  });

  expect(loadGlobalConfig).toHaveBeenCalled();
  expect(requireAuth).toHaveBeenCalled();
  expect(configureClient).toHaveBeenCalled();
  expect(queryWorkshopRulebook).toHaveBeenCalledWith({
    query: {
      title: "Chess",
    },
  });
  expect(consoleLog).toHaveBeenCalledWith(
    "Dreamboard sample rules text excerpt. Top-three fallback succeeded.",
  );
});
