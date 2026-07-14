import { queryWorkshopRulebook } from "@dreamboard-games/api-client";
import { defineCommand } from "citty";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { getStoredSession } from "../config/credential-store.js";
import {
  configureClient,
  requireAuth,
  resolveConfig,
} from "../config/resolve.js";
import { parseQueryCommandArgs } from "../flags.js";
import { toDreamboardApiError } from "../utils/errors.js";

export default defineCommand({
  meta: {
    name: "query",
    description: "Query rulebook text by title",
  },
  args: {
    title: {
      type: "positional",
      description: "Board game title to search in the rulebook library",
      required: true,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseQueryCommandArgs(args);
    const [globalConfig, storedSession] = await Promise.all([
      loadGlobalConfig(),
      getStoredSession(),
    ]);
    const config = resolveConfig(
      globalConfig,
      parsedArgs,
      undefined,
      storedSession,
    );
    requireAuth(config);
    await configureClient(config);

    const { data, error, response } = await queryWorkshopRulebook({
      query: {
        title: parsedArgs.title,
      },
    });

    if (!data) {
      throw toDreamboardApiError(
        error,
        response,
        `Failed to query rulebook for '${parsedArgs.title}'`,
      );
    }

    console.log(data.ruleText);
  },
});
