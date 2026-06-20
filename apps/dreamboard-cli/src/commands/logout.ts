import { defineCommand } from "citty";
import consola from "consola";
import {
  getGlobalAuthPath,
  loadGlobalConfig,
} from "../config/global-config.js";
import { getStoredSession } from "../config/credential-store.js";
import { resolveConfig } from "../config/resolve.js";
import { createUserSessionManager } from "../auth/user-session-manager.js";

export default defineCommand({
  meta: { name: "logout", description: "Clear the stored Dreamboard session" },
  args: {},
  async run() {
    const [globalConfig, storedSession] = await Promise.all([
      loadGlobalConfig(),
      getStoredSession(),
    ]);
    await createUserSessionManager(
      resolveConfig(globalConfig, {}, undefined, storedSession),
    ).logout();
    consola.success(`Logged out. Cleared session from ${getGlobalAuthPath()}.`);
  },
});
