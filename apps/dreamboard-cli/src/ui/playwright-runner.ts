import os from "node:os";
import path from "node:path";
import type { ResolvedConfig } from "../types.js";
import { createUserSessionManager } from "../auth/user-session-manager.js";
import { resolveLocalHarnessAccessToken } from "../config/local-harness-auth.js";

/**
 * Browser test runner helpers shared with reducer-native-test-harness (browser runner).
 * Screenshot / JSON scenario navigation helpers lived in the deleted `run` command.
 */
export function configurePlaywrightBrowsersPath(): void {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return;
  }

  const runtimeHome = process.env.HOME;
  let realHome: string;
  try {
    realHome = os.userInfo().homedir;
  } catch {
    return;
  }

  if (!runtimeHome || path.resolve(runtimeHome) === path.resolve(realHome)) {
    return;
  }

  const browserCachePath =
    process.platform === "darwin"
      ? path.join(realHome, "Library", "Caches", "ms-playwright")
      : process.platform === "win32"
        ? path.join(realHome, "AppData", "Local", "ms-playwright")
        : path.join(realHome, ".cache", "ms-playwright");

  process.env.PLAYWRIGHT_BROWSERS_PATH = browserCachePath;
}

export async function buildBrowserAuthInitScript(
  config: ResolvedConfig,
): Promise<string | null> {
  const resolvedToken =
    resolveLocalHarnessAccessToken(config) ??
    (await createUserSessionManager(config).resolveApiToken())?.token;
  if (!resolvedToken) return null;

  return `(function(){localStorage.setItem('dreamboard_auth_token',${JSON.stringify(resolvedToken)});})();`;
}

export async function waitForGameReady(
  page: import("playwright").Page,
  timeoutMs = 60000,
): Promise<void> {
  await page.waitForSelector('iframe[title="Game UI Plugin"]', {
    timeout: timeoutMs,
  });
}
