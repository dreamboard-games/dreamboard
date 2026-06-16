import os from "node:os";
import path from "node:path";
import type { CredentialBackendPreference, GlobalConfig } from "../types.js";
import { PROJECT_DIR_NAME } from "../constants.js";
import { ensureDir, readJsonFile } from "../utils/fs.js";
import { atomicWriteFile } from "../utils/atomic-file.js";
import { getCredentialFilePath } from "./credential-store.js";

function normalizeCredentialBackend(
  value: unknown,
): CredentialBackendPreference | undefined {
  if (value === "file" || value === "keychain") return value;
  // Tolerate unknown / malformed values rather than refusing to load the
  // whole config - an unrecognised backend name should degrade to "use
  // the default" instead of locking the user out of their CLI.
  return undefined;
}

export function getGlobalConfigPath(): string {
  return path.join(os.homedir(), PROJECT_DIR_NAME, "config.json");
}

/**
 * Path to the on-disk credential file used by the file backend of
 * `CredentialStore`. Re-exported here to avoid circular / ad-hoc imports
 * in UI surface (`auth status`, `config show`, etc).
 */
export function getGlobalAuthPath(): string {
  return getCredentialFilePath();
}

/**
 * Load non-credential CLI configuration.
 *
 * Note: this function used to also load `authToken` / `refreshToken`
 * from `auth.json` and flatten them onto `GlobalConfig`. That shape
 * enabled the refresh-token-wipe bug: `saveGlobalConfig({ ...config })`
 * without explicit auth fields erased the stored refresh token.
 *
 * Credentials are now owned exclusively by `CredentialStore`. Callers
 * that need them must import `getCredentials()` directly.
 */
export async function loadGlobalConfig(): Promise<GlobalConfig> {
  const config = await readJsonFile<GlobalConfig>(getGlobalConfigPath()).catch(
    () => ({}) as GlobalConfig,
  );
  return {
    environment: config.environment,
    credentialBackend: normalizeCredentialBackend(config.credentialBackend),
  };
}

/**
 * Persist non-credential CLI configuration.
 *
 * This function cannot write credentials, by construction: the
 * `GlobalConfig` type has no credential fields. Credentials must be
 * persisted through `setCredentials` / `clearCredentials` from
 * `credential-store.ts`.
 */
export async function saveGlobalConfig(config: GlobalConfig): Promise<void> {
  const configDir = path.join(os.homedir(), PROJECT_DIR_NAME);
  await ensureDir(configDir);
  const normalized: GlobalConfig = {
    environment: config.environment,
    credentialBackend: normalizeCredentialBackend(config.credentialBackend),
  };
  await atomicWriteFile(
    getGlobalConfigPath(),
    `${JSON.stringify(normalized, null, 2)}\n`,
    { mode: 0o600 },
  );
}
