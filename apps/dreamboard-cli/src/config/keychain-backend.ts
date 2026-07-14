/**
 * OS keychain-backed `CredentialBackend` built on top of `@napi-rs/keyring`.
 *
 * Keychain is an optional storage backend. Users can opt in with
 * `credentialBackend: "keychain"` in `~/.dreamboard/config.json`
 * (see `credential-store.ts` for the resolver).
 * When enabled, it gives us:
 * - A refresh token encrypted at rest by the OS (Keychain on macOS,
 *   Credential Vault on Windows, Secret Service on Linux).
 * - Protection against other processes running as the same user tailing
 *   `~/.dreamboard/auth.json` to scrape the token.
 *
 * This module is loaded optionally: `@napi-rs/keyring` is declared as an
 * `optionalDependencies` entry. If the native binary or OS keyring is
 * unavailable, the resolver falls back to the file backend.
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
    // missing on this platform the dynamic import throws; resolver policy in
    // credential-store decides whether that is fatal.
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
  clerkAccessToken?: string;
  refreshToken?: string;
  clerkAccessExpiresAt?: string;
  dreamboardApiToken?: string;
  dreamboardApiExpiresAt?: string;
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
    const accessToken = parsed.clerkAccessToken;
    if (!accessToken && !parsed.refreshToken) return null;
    return {
      accessToken: accessToken || undefined,
      refreshToken: parsed.refreshToken || undefined,
      tokenExpiresAt: parsed.clerkAccessExpiresAt || undefined,
      dreamboardApiToken: parsed.dreamboardApiToken || undefined,
      dreamboardApiExpiresAt: parsed.dreamboardApiExpiresAt || undefined,
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
    clerkAccessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    clerkAccessExpiresAt: creds.tokenExpiresAt,
    dreamboardApiToken: creds.dreamboardApiToken,
    dreamboardApiExpiresAt: creds.dreamboardApiExpiresAt,
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
  const payload: KeychainPayload = { clerkAccessToken: accessToken };
  entry.setPassword(JSON.stringify(payload));
}

function clear(entry: EntryInstance): void {
  try {
    entry.deletePassword();
  } catch {
    // keyring-rs throws when the entry does not exist. That is fine -
    // Session clearing is idempotent.
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
