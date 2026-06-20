import { defineCommand } from "citty";
import consola from "consola";
import type { GlobalConfig, Environment } from "../types.js";
import { IS_PUBLISHED_BUILD } from "../build-target.js";
import { resolveConfig, valueOrUndefined } from "../config/resolve.js";
import { parseConfigCommandArgs } from "../flags.js";
import {
  getGlobalAuthPath,
  getGlobalConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
} from "../config/global-config.js";
import {
  findProjectRoot,
  loadProjectConfig,
  updateProjectState,
} from "../config/project-config.js";
import { getStoredSession } from "../config/credential-store.js";
import { createUserSessionManager } from "../auth/user-session-manager.js";

export default defineCommand({
  meta: {
    name: "config",
    description: IS_PUBLISHED_BUILD
      ? "View CLI configuration"
      : "View or update CLI configuration",
  },
  args: {
    action: {
      type: "positional",
      description: IS_PUBLISHED_BUILD ? "Action: show" : "Action: show | set",
      default: "show",
    },
    ...(IS_PUBLISHED_BUILD
      ? {}
      : {
          env: {
            type: "string" as const,
            description: "Environment: local | staging | prod",
          },
          token: {
            type: "string" as const,
            description: "Auth token (Dreamboard bearer JWT)",
          },
          scope: {
            type: "string" as const,
            description: "Config scope: global | workspace",
            default: "global",
          },
        }),
  },
  async run({ args }) {
    const parsedArgs = parseConfigCommandArgs(args);
    const action = parsedArgs.action;
    const globalConfig = await loadGlobalConfig();

    if (action === "show") {
      const storedSession = await getStoredSession();
      const projectRoot = await findProjectRoot(process.cwd());
      const projectConfig = projectRoot
        ? await loadProjectConfig(projectRoot).catch(() => undefined)
        : undefined;
      const config = resolveConfig(
        globalConfig,
        parsedArgs,
        projectConfig,
        storedSession,
      );
      console.log(
        JSON.stringify(
          IS_PUBLISHED_BUILD
            ? {
                configPath: getGlobalConfigPath(),
                authPath: getGlobalAuthPath(),
                authenticated: Boolean(config.authToken),
                refreshableSession: Boolean(config.refreshToken),
              }
            : {
                configPath: getGlobalConfigPath(),
                authPath: getGlobalAuthPath(),
                environment:
                  parsedArgs.env ||
                  projectConfig?.environment ||
                  globalConfig.environment ||
                  "staging",
                workspaceConfigPath: projectRoot
                  ? `${projectRoot}/.dreamboard/project.json`
                  : undefined,
                workspaceEnvironment: projectConfig?.environment,
                apiBaseUrl: config.apiBaseUrl,
                webBaseUrl: config.webBaseUrl,
                authenticated: Boolean(config.authToken),
                refreshableSession: Boolean(config.refreshToken),
              },
          null,
          2,
        ),
      );
      return;
    }

    if (action === "set") {
      if (IS_PUBLISHED_BUILD) {
        throw new Error(
          "The published Dreamboard CLI does not support config overrides. Use `dreamboard auth login` to authenticate.",
        );
      }
      if (parsedArgs.scope === "workspace") {
        const projectRoot = await findProjectRoot(process.cwd());
        if (!projectRoot) {
          throw new Error(
            "Workspace-scoped config requires a Dreamboard project (.dreamboard/project.json).",
          );
        }
        const projectConfig = await loadProjectConfig(projectRoot);
        await updateProjectState(projectRoot, {
          ...projectConfig,
          ...(parsedArgs.env
            ? { environment: parsedArgs.env as Environment }
            : {}),
        });
      } else {
        const updated: GlobalConfig = { ...globalConfig };
        if (parsedArgs.env) updated.environment = parsedArgs.env as Environment;
        await saveGlobalConfig(updated);
      }

      const overrideToken = valueOrUndefined(parsedArgs.token);
      if (overrideToken) {
        // `config set --token` is an access-only override. Never write a
        // refresh token through this path - that belongs to
        // `dreamboard auth login`.
        const storedSession = await getStoredSession();
        const config = resolveConfig(
          globalConfig,
          parsedArgs,
          undefined,
          storedSession,
        );
        await createUserSessionManager(config).establishAccessOnlySession(
          overrideToken,
        );
      }
      consola.success("Config updated.");
      return;
    }

    throw new Error(
      IS_PUBLISHED_BUILD
        ? "Usage: dreamboard config show"
        : "Usage: dreamboard config show | dreamboard config set --env <local|staging|prod>",
    );
  },
});
