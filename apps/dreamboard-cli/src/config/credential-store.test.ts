import { expect, mock, test } from "bun:test";

const tryKeychainBackend = mock(async () => ({
  available: false as const,
  reason: "OS keyring unavailable in test",
}));

mock.module("../build-target.js", () => ({
  IS_PUBLISHED_BUILD: true,
  PUBLISHED_ENVIRONMENT: "prod",
}));

mock.module("./keychain-backend.js", () => ({
  tryKeychainBackend,
}));

const {
  _resetCredentialStoreForTests,
  getCredentialBackend,
  getStoredSession,
  CredentialStoreUnavailableError,
} = await import("./credential-store.ts");

test("published credential backend fails closed when keyring is unavailable", async () => {
  _resetCredentialStoreForTests();
  tryKeychainBackend.mockClear();

  await expect(getCredentialBackend()).rejects.toThrow(
    CredentialStoreUnavailableError,
  );
  await expect(getCredentialBackend()).rejects.toThrow(
    "OS keyring unavailable in test",
  );
  expect(tryKeychainBackend).toHaveBeenCalledTimes(2);
});

test("agent token bypasses stored session lookup in published builds", async () => {
  _resetCredentialStoreForTests();
  tryKeychainBackend.mockClear();
  process.env.DREAMBOARD_AGENT_TOKEN = "agent-token";

  try {
    await expect(getStoredSession()).resolves.toBeNull();
    expect(tryKeychainBackend).not.toHaveBeenCalled();
  } finally {
    delete process.env.DREAMBOARD_AGENT_TOKEN;
  }
});
