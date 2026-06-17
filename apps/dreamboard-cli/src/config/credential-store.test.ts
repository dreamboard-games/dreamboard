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
} = await import("./credential-store.ts");

test("published builds default to the file credential backend", async () => {
  _resetCredentialStoreForTests();
  tryKeychainBackend.mockClear();

  await expect(getCredentialBackend()).resolves.toMatchObject({
    name: "file",
  });
  expect(tryKeychainBackend).not.toHaveBeenCalled();
});

test("published builds only probe keychain after explicit opt-in", async () => {
  _resetCredentialStoreForTests();
  tryKeychainBackend.mockClear();
  process.env.DREAMBOARD_CREDENTIAL_BACKEND = "keychain";

  try {
    await expect(getCredentialBackend()).resolves.toMatchObject({
      name: "file",
    });
    expect(tryKeychainBackend).toHaveBeenCalledTimes(1);
  } finally {
    delete process.env.DREAMBOARD_CREDENTIAL_BACKEND;
  }
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
