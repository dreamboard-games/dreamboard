import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  _setCredentialDirectoryForTests,
  clearCredentials,
  getCredentialBackend,
  getCredentialAuditLogPath,
  getCredentialFilePath,
  getStoredSession,
  setCredentials,
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

test("file credential deletion writes a redacted local audit event", async () => {
  _resetCredentialStoreForTests();
  tryKeychainBackend.mockClear();
  const tempHome = await mkdtemp(
    path.join(os.tmpdir(), "dreamboard-credential-audit-"),
  );
  const credentialDir = path.join(tempHome, ".dreamboard");
  _setCredentialDirectoryForTests(credentialDir);

  try {
    await setCredentials({
      accessToken: "clerk-access-token",
      refreshToken: "clerk-refresh-token",
      environment: "staging",
    });

    await clearCredentials("auth_clear_command");

    await expect(getStoredSession()).resolves.toBeNull();
    const logText = await readFile(getCredentialAuditLogPath(), "utf8");
    const entries = logText
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    const deletionEntry = entries.find(
      (entry) =>
        entry.event === "auth_file_deleted" &&
        entry.reason === "auth_clear_command" &&
        entry.authPath === getCredentialFilePath(),
    );
    expect(deletionEntry).toMatchObject({
      event: "auth_file_deleted",
      reason: "auth_clear_command",
      authPath: getCredentialFilePath(),
      backend: "file",
    });
    expect(typeof deletionEntry?.timestamp).toBe("string");
    expect(typeof deletionEntry?.pid).toBe("number");
    expect(JSON.stringify(entries)).not.toContain("clerk-access-token");
    expect(JSON.stringify(entries)).not.toContain("clerk-refresh-token");
  } finally {
    _resetCredentialStoreForTests();
    await rm(tempHome, { recursive: true, force: true });
  }
});
