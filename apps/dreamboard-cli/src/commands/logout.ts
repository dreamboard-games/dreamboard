import { defineCommand } from "citty";
import consola from "consola";
import { getGlobalAuthPath } from "../config/global-config.js";
import { clearCredentials } from "../config/credential-store.js";

export default defineCommand({
  meta: { name: "logout", description: "Clear the stored Dreamboard session" },
  args: {},
  async run() {
    await clearCredentials();
    consola.success(`Logged out. Cleared session from ${getGlobalAuthPath()}.`);
  },
});
