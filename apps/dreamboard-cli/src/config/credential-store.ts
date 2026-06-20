/**
 * Single writer for the long-lived Dreamboard session credentials.
 *
 * Design invariants (enforced at the type level and tested in
 * `credential-store.test.ts`):
 *
 * 1. This module is the ONLY place in the CLI that writes credentials to
 *    disk or the OS keychain. `global-config.ts` used to own both the
 *    config and the credentials via `saveGlobalConfig`, which made it
 *    trivial to wipe a refresh token by accident. The `GlobalConfig` type
 *    no longer carries credentials, so attempting to persist one through
 *    the config path is a type error.
 *
 * 2. Product credential mutations are owned by `user-session-manager.ts`.
 *    This module exposes the locked backend operations it needs, but no
 *    command-level write helpers. `Credentials` requires both the Clerk
 *    access and refresh tokens, while derived Dreamboard audience tokens are
 *    optional caches.
 *
 * 3. Writes go through `atomicWriteFile` + `withFileLock`, so a crash or
 *    interrupt during `dreamboard sync`/`compile` cannot leave `auth.json`
 *    truncated, and parallel CLI invocations cannot clobber each other's
 *    rotated refresh tokens.
 *
 * 4. The on-disk JSON shape for the file backend is kept backward
 *    compatible: we continue to read/write `authToken` + `refreshToken`
 *    so existing users are not forced to log in again after this change.
 *    A newer `accessToken` key is also accepted for read to ease any
 *    future format bump.
 *
 * 5. All builds default to the file backend. The OS keychain is an explicit
 *    opt-in through config or `DREAMBOARD_CREDENTIAL_BACKEND=keychain`.
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { PROJECT_DIR_NAME } from "../constants.js";
import {
  atomicWriteFile,
  withFileLock,
  type FileLockOptions,
} from "../utils/atomic-file.js";

/**
 * Fully refreshable session. `accessToken` is the Clerk OAuth bootstrap token
 * retained for refresh/exchange compatibility; ordinary API calls use
 * `dreamboardApiToken`.
 */
export type Credentials = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly tokenExpiresAt?: string;
  readonly dreamboardApiToken?: string;
  readonly dreamboardApiExpiresAt?: string;
  readonly clerkOAuthIssuer?: string;
  readonly clerkOAuthClientId?: string;
  readonly clerkOAuthTokenUrl?: string;
  readonly environment?: string;
};

/**
 * Raw on-disk snapshot. Either or both fields may be present. The refresh
 * coordinator only acts on snapshots that have both tokens populated.
 */
export type StoredSessionSnapshot = {
  readonly accessToken?: string;
  readonly refreshToken?: string;
  readonly tokenExpiresAt?: string;
  readonly dreamboardApiToken?: string;
  readonly dreamboardApiExpiresAt?: string;
  readonly clerkOAuthIssuer?: string;
  readonly clerkOAuthClientId?: string;
  readonly clerkOAuthTokenUrl?: string;
  readonly environment?: string;
};

export type CredentialBackendName = "file" | "keychain";

export type CredentialBackend = {
  readonly name: CredentialBackendName;
  read(): Promise<StoredSessionSnapshot | null>;
  writeFull(creds: Credentials): Promise<void>;
  writeAccessOnly(accessToken: string): Promise<void>;
  clear(reason?: CredentialClearReason): Promise<void>;
};

export type CredentialLockOps = {
  readonly backendName: CredentialBackendName;
  read(): Promise<StoredSessionSnapshot | null>;
  writeFull(creds: Credentials): Promise<void>;
  writeAccessOnly(accessToken: string): Promise<void>;
  clear(reason?: CredentialClearReason): Promise<void>;
};

export type CredentialClearReason =
  | "auth_clear_command"
  | "logout_command"
  | "credential_store_clear";

type DiskShape = Partial<{
  clerkAccessToken: string;
  clerkAccessExpiresAt: string;
  accessToken: string;
  authToken: string;
  refreshToken: string;
  tokenExpiresAt: string;
  dreamboardApiToken: string;
  dreamboardApiExpiresAt: string;
  clerkOAuthIssuer: string;
  clerkOAuthClientId: string;
  clerkOAuthTokenUrl: string;
  environment: string;
}>;

let credentialDirectoryOverrideForTests: string | null = null;

function getCredentialDirectory(): string {
  return (
    credentialDirectoryOverrideForTests ??
    path.join(os.homedir(), PROJECT_DIR_NAME)
  );
}

export function getCredentialFilePath(): string {
  return path.join(getCredentialDirectory(), "auth.json");
}

export function getCredentialAuditLogPath(): string {
  return path.join(getCredentialDirectory(), "auth-events.log");
}

function getCredentialLockPath(): string {
  return `${getCredentialFilePath()}.lock`;
}

async function appendCredentialAuditEvent(event: {
  readonly event: "auth_file_deleted" | "auth_file_delete_missing";
  readonly reason: CredentialClearReason;
  readonly authPath: string;
  readonly backend: CredentialBackendName;
}): Promise<void> {
  try {
    const logPath = getCredentialAuditLogPath();
    await fs.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    await fs.appendFile(
      logPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        pid: process.pid,
        ...event,
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Credential clearing must not fail because local diagnostic logging failed.
  }
}

async function fileRead(): Promise<StoredSessionSnapshot | null> {
  const filePath = getCredentialFilePath();
  let data: string;
  try {
    data = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (data.trim().length === 0) {
    return null;
  }
  let parsed: DiskShape;
  try {
    parsed = JSON.parse(data) as DiskShape;
  } catch {
    return null;
  }
  const accessToken =
    parsed.clerkAccessToken ?? parsed.accessToken ?? parsed.authToken;
  const refreshToken = parsed.refreshToken;
  if (!accessToken && !refreshToken) return null;
  return {
    accessToken: accessToken || undefined,
    refreshToken: refreshToken || undefined,
    tokenExpiresAt:
      parsed.clerkAccessExpiresAt || parsed.tokenExpiresAt || undefined,
    dreamboardApiToken: parsed.dreamboardApiToken || undefined,
    dreamboardApiExpiresAt: parsed.dreamboardApiExpiresAt || undefined,
    clerkOAuthIssuer: parsed.clerkOAuthIssuer || undefined,
    clerkOAuthClientId: parsed.clerkOAuthClientId || undefined,
    clerkOAuthTokenUrl: parsed.clerkOAuthTokenUrl || undefined,
    environment: parsed.environment || undefined,
  };
}

async function writeFilePayload(payload: DiskShape): Promise<void> {
  await atomicWriteFile(
    getCredentialFilePath(),
    `${JSON.stringify(payload, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function fileWriteFull(creds: Credentials): Promise<void> {
  if (!creds.accessToken || !creds.refreshToken) {
    throw new Error(
      "Refusing to persist credentials with an empty accessToken or refreshToken.",
    );
  }
  await writeFilePayload({
    clerkAccessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    clerkAccessExpiresAt: creds.tokenExpiresAt,
    dreamboardApiToken: creds.dreamboardApiToken,
    dreamboardApiExpiresAt: creds.dreamboardApiExpiresAt,
    clerkOAuthIssuer: creds.clerkOAuthIssuer,
    clerkOAuthClientId: creds.clerkOAuthClientId,
    clerkOAuthTokenUrl: creds.clerkOAuthTokenUrl,
    environment: creds.environment,
  });
}

async function fileWriteAccessOnly(accessToken: string): Promise<void> {
  if (!accessToken) {
    throw new Error("Refusing to persist an empty access token.");
  }
  await writeFilePayload({ authToken: accessToken });
}

async function fileClear(
  reason: CredentialClearReason = "credential_store_clear",
): Promise<void> {
  const filePath = getCredentialFilePath();
  try {
    await fs.unlink(filePath);
    await appendCredentialAuditEvent({
      event: "auth_file_deleted",
      reason,
      authPath: filePath,
      backend: "file",
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      await appendCredentialAuditEvent({
        event: "auth_file_delete_missing",
        reason,
        authPath: filePath,
        backend: "file",
      });
      return;
    }
    throw err;
  }
}

export const fileCredentialBackend: CredentialBackend = {
  name: "file",
  read: fileRead,
  writeFull: fileWriteFull,
  writeAccessOnly: fileWriteAccessOnly,
  clear: fileClear,
};

export type BackendResolver = () =>
  | CredentialBackend
  | Promise<CredentialBackend>;

export class CredentialStoreUnavailableError extends Error {
  readonly code = "CREDENTIAL_STORE_UNAVAILABLE";

  constructor(reason: string) {
    super(`Credential store unavailable: ${reason}`);
    this.name = "CredentialStoreUnavailableError";
  }
}

let cachedBackend: CredentialBackend | null = null;
let migrationCompleted = false;
let backendResolver: BackendResolver = defaultBackendResolver;

/**
 * Resolver precedence for all builds:
 *
 *   1. `DREAMBOARD_CREDENTIAL_BACKEND` env var (debugging / CI override).
 *        - "file"     -> force file
 *        - "keychain" -> force keychain (falls back to file if the native
 *                        module or the OS keyring is unavailable)
 *        - "auto"     -> same as unset (use config)
 *        - unknown    -> throw so typos fail loud
 *   2. `credentialBackend` in `~/.dreamboard/config.json`.
 *        - "keychain" -> opt in to the OS keychain (with file fallback)
 *        - "file" / unset / malformed -> file
 *   3. Default: file backend.
 *
 * Keychain is opt-in because on macOS the OS login-keychain prompts for
 * the user's password the first time a new binary tries to write to an
 * item, and re-prompts whenever the Node binary signature changes. We
 * would rather ship a zero-prompt default and let users who care about
 * encrypted-at-rest storage enable it.
 *
 * The resolver is async because the keychain probe requires a dynamic
 * `@napi-rs/keyring` import.
 */
async function defaultBackendResolver(): Promise<CredentialBackend> {
  const override = (process.env.DREAMBOARD_CREDENTIAL_BACKEND ?? "")
    .trim()
    .toLowerCase();
  if (override === "file") {
    return fileCredentialBackend;
  }
  if (override && override !== "keychain" && override !== "auto") {
    // Fail loud on typos rather than silently falling back: this env
    // var exists specifically for users who are debugging auth issues
    // and need to know their override took effect.
    throw new Error(
      `Unknown DREAMBOARD_CREDENTIAL_BACKEND value "${override}" (expected "file", "keychain", or "auto").`,
    );
  }

  const useKeychain =
    override === "keychain" || (await readCredentialBackendPreference());
  if (!useKeychain) {
    return fileCredentialBackend;
  }

  const { tryKeychainBackend } = await import("./keychain-backend.js");
  const keychain = await tryKeychainBackend();
  if (keychain.available) {
    return keychain.backend;
  }
  // The user explicitly asked for keychain but the platform can't
  // provide one (no libsecret on Linux, missing native module, etc).
  // Silently degrade to the file backend so the CLI stays usable; the
  // active backend is still visible through `dreamboard auth status`.
  return fileCredentialBackend;
}

async function readCredentialBackendPreference(): Promise<boolean> {
  try {
    // Dynamic import to avoid a top-level cycle with `global-config.ts`
    // (which imports `getCredentialFilePath` from this module). Using
    // the async path keeps the cycle purely lazy.
    const { loadGlobalConfig } = await import("./global-config.js");
    const config = await loadGlobalConfig();
    return config.credentialBackend === "keychain";
  } catch {
    // If the config file is unreadable or the dynamic import fails
    // (e.g. during early bootstrap), fall back to the file-backed
    // default rather than crashing credential lookups.
    return false;
  }
}

/**
 * Override which backend is used. Tests use this to inject in-memory
 * backends; production code uses the file-default resolver.
 */
export function setCredentialBackendResolver(resolver: BackendResolver): void {
  backendResolver = resolver;
  cachedBackend = null;
  migrationCompleted = false;
}

export async function getCredentialBackend(): Promise<CredentialBackend> {
  if (cachedBackend === null) {
    cachedBackend = await backendResolver();
    // One-time migration: if we resolved to a non-file backend and
    // `auth.json` still has credentials from the old layout, copy them
    // over. The file is intentionally left in place; implicit backend
    // migration must not make a working CLI session appear to vanish from
    // the default file-backed view.
    if (!migrationCompleted && cachedBackend.name !== "file") {
      await migrateFromFileBackendIfNeeded(cachedBackend);
    }
    migrationCompleted = true;
  }
  return cachedBackend;
}

async function migrateFromFileBackendIfNeeded(
  target: CredentialBackend,
  options: { failClosed?: boolean } = {},
): Promise<void> {
  try {
    const [onDisk, onTarget] = await Promise.all([
      fileCredentialBackend.read(),
      target.read(),
    ]);
    if (!onDisk) return;
    if (onTarget) {
      // Target already has a session - the user has already migrated. Leave the
      // file copy alone so a transient keychain override/probe cannot remove
      // the visible file-backed session.
      return;
    }
    if (onDisk.accessToken && onDisk.refreshToken) {
      const migrated: Credentials = {
        accessToken: onDisk.accessToken,
        refreshToken: onDisk.refreshToken,
        tokenExpiresAt: onDisk.tokenExpiresAt,
        dreamboardApiToken: onDisk.dreamboardApiToken,
        dreamboardApiExpiresAt: onDisk.dreamboardApiExpiresAt,
        clerkOAuthIssuer: onDisk.clerkOAuthIssuer,
        clerkOAuthClientId: onDisk.clerkOAuthClientId,
        clerkOAuthTokenUrl: onDisk.clerkOAuthTokenUrl,
        environment: onDisk.environment,
      };
      await target.writeFull(migrated);
      await verifyMigratedSession(target, migrated);
    } else if (onDisk.accessToken) {
      await target.writeAccessOnly(onDisk.accessToken);
      const migrated = await target.read();
      if (migrated?.accessToken !== onDisk.accessToken) {
        throw new Error("Credential migration verification failed.");
      }
    } else {
      return;
    }
  } catch (error) {
    if (options.failClosed) {
      throw new CredentialStoreUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
    // Migration is best-effort. A failure here should not block CLI
    // operation; on next run the file backend is still consulted
    // directly because the keychain backend's `read` returns null and
    // callers fall through to "missing session" → login prompt.
  }
}

async function verifyMigratedSession(
  target: CredentialBackend,
  expected: Credentials,
): Promise<void> {
  const migrated = await target.read();
  if (
    migrated?.accessToken !== expected.accessToken ||
    migrated.refreshToken !== expected.refreshToken
  ) {
    throw new Error("Credential migration verification failed.");
  }
}

export async function getActiveCredentialBackendName(): Promise<CredentialBackendName> {
  const backend = await getCredentialBackend();
  return backend.name;
}

/** Loose read: returns whatever is on disk, including access-only sessions. */
export async function getStoredSession(): Promise<StoredSessionSnapshot | null> {
  if (process.env.DREAMBOARD_AGENT_TOKEN?.trim()) {
    return null;
  }
  const backend = await getCredentialBackend();
  return backend.read();
}

/** Strict read: returns a refreshable pair, or null if either token is missing. */
export async function getCredentials(): Promise<Credentials | null> {
  const snapshot = await getStoredSession();
  if (!snapshot) return null;
  const { accessToken, refreshToken } = snapshot;
  if (!accessToken || !refreshToken) return null;
  return {
    accessToken,
    refreshToken,
    tokenExpiresAt: snapshot.tokenExpiresAt,
    dreamboardApiToken: snapshot.dreamboardApiToken,
    dreamboardApiExpiresAt: snapshot.dreamboardApiExpiresAt,
    clerkOAuthIssuer: snapshot.clerkOAuthIssuer,
    clerkOAuthClientId: snapshot.clerkOAuthClientId,
    clerkOAuthTokenUrl: snapshot.clerkOAuthTokenUrl,
    environment: snapshot.environment,
  };
}

/**
 * Run `fn` while holding the cross-process credential lock. `fn` receives
 * an ops handle that reads/writes the active backend without re-acquiring
 * the lock (avoiding deadlock).
 *
 * This is the only correct way to perform a read-modify-write on stored
 * credentials (e.g. CLI refresh rotation) in the presence of
 * concurrent CLI invocations.
 */
export async function withCredentialLock<T>(
  fn: (ops: CredentialLockOps) => Promise<T>,
  options?: FileLockOptions,
): Promise<T> {
  return withFileLock(
    getCredentialLockPath(),
    async () => {
      const backend = await getCredentialBackend();
      const ops: CredentialLockOps = {
        backendName: backend.name,
        read: () => backend.read(),
        writeFull: (creds) => backend.writeFull(creds),
        writeAccessOnly: (accessToken) => backend.writeAccessOnly(accessToken),
        clear: (reason) => backend.clear(reason),
      };
      return fn(ops);
    },
    options,
  );
}

/** Test-only reset of module state. Not exported through the barrel. */
export function _resetCredentialStoreForTests(): void {
  cachedBackend = null;
  migrationCompleted = false;
  backendResolver = defaultBackendResolver;
  credentialDirectoryOverrideForTests = null;
}

/** Test-only override of the credential directory. Not exported through the barrel. */
export function _setCredentialDirectoryForTests(
  directory: string | null,
): void {
  credentialDirectoryOverrideForTests = directory;
  cachedBackend = null;
  migrationCompleted = false;
}
