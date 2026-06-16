/**
 * OS keychain-backed `CredentialBackend` built on top of `@napi-rs/keyring`.
 *
 * Keychain is an *opt-in* storage backend, enabled by setting
 * `credentialBackend: "keychain"` in `~/.dreamboard/config.json` (see
 * `credential-store.ts` for the resolver). When enabled, it gives us:
 * - A refresh token encrypted at rest by the OS (Keychain on macOS,
 *   Credential Vault on Windows, Secret Service on Linux).
 * - Protection against other processes running as the same user tailing
 *   `~/.dreamboard/auth.json` to scrape the token.
 *
 * It is not the default because on macOS the first keychain write
 * triggers a login-password prompt, and macOS re-prompts whenever the
 * executing Node binary's code signature changes (e.g. after an
 * `nvm`/`volta` upgrade). The zero-prompt file backend is a better
 * out-of-the-box experience for CLI users.
 *
 * This module is loaded optionally: `@napi-rs/keyring` is declared as an
 * `optionalDependencies` entry so environments where the native binary is
 * unavailable (e.g. Alpine containers, Linux without libsecret, some CI
 * images) still get a working CLI via the file backend fallback.
 *
 * One-time migration: when a user opts into the keychain and `auth.json`
 * still has tokens, `credential-store.ts` copies them into the keychain
 * and deletes the file. This is the only path that intentionally mutates
 * both backends.
 */

import type {
  CredentialBackend,
  Credentials,
  StoredSessionSnapshot,
} from "./credential-store.js";

/** Keychain service id. Shared across all Dreamboard CLI builds. */
const KEYCHAIN_SERVICE = "dreamboard-cli";
/**
 * Keychain account id. The `user@host` shape is conventional but we keep
 * it fixed for now because the CLI only cares about "the session for this
 * OS user", not per-process sessions.
 */
const KEYCHAIN_ACCOUNT = "session";

type EntryInstance = {
  setPassword(value: string): void;
  getPassword(): string | null | undefined;
  deletePassword(): boolean;
};

type KeyringModule = {
  Entry: new (service: string, account: string) => EntryInstance;
};

let cachedModule: KeyringModule | null | undefined;

async function loadKeyringModule(): Promise<KeyringModule | null> {
  if (cachedModule !== undefined) return cachedModule;
  try {
    // `@napi-rs/keyring` is an optional dependency. If the native binary is
    // missing on this platform the dynamic import throws; we swallow that
    // and fall back to the file backend.
    const mod = (await import("@napi-rs/keyring")) as unknown as KeyringModule;
    cachedModule = mod;
  } catch {
    cachedModule = null;
  }
  return cachedModule;
}

function keychainProbe(entry: EntryInstance): boolean {
  // Some platforms have the module installed but no accessible keyring
  // (e.g. headless Linux without DBus). Touch getPassword to verify we
  // can talk to the service without side effects.
  try {
    entry.getPassword();
    return true;
  } catch {
    return false;
  }
}

type KeychainPayload = {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
  clerkOAuthIssuer?: string;
  clerkOAuthClientId?: string;
  clerkOAuthTokenUrl?: string;
  environment?: string;
};

function parsePayload(
  raw: string | null | undefined,
): StoredSessionSnapshot | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = JSON.parse(trimmed) as KeychainPayload;
    if (!parsed.accessToken && !parsed.refreshToken) return null;
    return {
      accessToken: parsed.accessToken || undefined,
      refreshToken: parsed.refreshToken || undefined,
      tokenExpiresAt: parsed.tokenExpiresAt || undefined,
      clerkOAuthIssuer: parsed.clerkOAuthIssuer || undefined,
      clerkOAuthClientId: parsed.clerkOAuthClientId || undefined,
      clerkOAuthTokenUrl: parsed.clerkOAuthTokenUrl || undefined,
      environment: parsed.environment || undefined,
    };
  } catch {
    return null;
  }
}

function writeFull(entry: EntryInstance, creds: Credentials): void {
  if (!creds.accessToken || !creds.refreshToken) {
    throw new Error(
      "Refusing to persist credentials with an empty accessToken or refreshToken.",
    );
  }
  const payload: KeychainPayload = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    tokenExpiresAt: creds.tokenExpiresAt,
    clerkOAuthIssuer: creds.clerkOAuthIssuer,
    clerkOAuthClientId: creds.clerkOAuthClientId,
    clerkOAuthTokenUrl: creds.clerkOAuthTokenUrl,
    environment: creds.environment,
  };
  entry.setPassword(JSON.stringify(payload));
}

function writeAccessOnly(entry: EntryInstance, accessToken: string): void {
  if (!accessToken) {
    throw new Error("Refusing to persist an empty access token.");
  }
  const payload: KeychainPayload = { accessToken };
  entry.setPassword(JSON.stringify(payload));
}

function clear(entry: EntryInstance): void {
  try {
    entry.deletePassword();
  } catch {
    // keyring-rs throws when the entry does not exist. That is fine -
    // `clearCredentials` contracts as idempotent.
  }
}

export type KeychainAvailability =
  | { available: true; backend: CredentialBackend }
  | { available: false; reason: string };

/**
 * Attempt to construct a keychain-backed `CredentialBackend`. Returns an
 * `available: false` result (with a reason) if the native module, the
 * OS keyring, or the probe fails.
 */
export async function tryKeychainBackend(): Promise<KeychainAvailability> {
  const mod = await loadKeyringModule();
  if (!mod) {
    return {
      available: false,
      reason: "@napi-rs/keyring is not installed for this platform",
    };
  }

  let entry: EntryInstance;
  try {
    entry = new mod.Entry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch (err) {
    return {
      available: false,
      reason: `Failed to construct keyring entry: ${String((err as Error).message ?? err)}`,
    };
  }

  if (!keychainProbe(entry)) {
    return {
      available: false,
      reason: "OS keyring is not accessible from this process",
    };
  }

  const backend: CredentialBackend = {
    name: "keychain",
    async read() {
      try {
        return parsePayload(entry.getPassword());
      } catch (err) {
        const message = String((err as Error).message ?? err);
        // Transient keychain access errors (e.g. Touch ID prompt
        // cancelled) should not surface as "session wiped". Treat the
        // unreadable state as "no session" so the caller can fall back
        // to prompting for login.
        if (/no matching entry|not found/i.test(message)) {
          return null;
        }
        throw err;
      }
    },
    async writeFull(creds) {
      writeFull(entry, creds);
    },
    async writeAccessOnly(accessToken) {
      writeAccessOnly(entry, accessToken);
    },
    async clear() {
      clear(entry);
    },
  };
  return { available: true, backend };
}

/**
 * Test-only escape hatch so unit tests can install a fake keyring module
 * without going through the dynamic import cache.
 */
export function _setKeyringModuleForTests(mod: KeyringModule | null): void {
  cachedModule = mod;
}

export function _resetKeyringModuleForTests(): void {
  cachedModule = undefined;
}
