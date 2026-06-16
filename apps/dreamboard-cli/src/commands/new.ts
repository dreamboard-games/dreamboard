import path from "node:path";
import { defineCommand } from "citty";
import consola from "consola";
import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import {
  resolveConfig,
  requireAuth,
  configureClient,
} from "../config/resolve.js";
import { parseNewCommandArgs } from "../flags.js";
import { loadGlobalConfig } from "../config/global-config.js";
import { getStoredSession } from "../config/credential-store.js";
import { normalizeSlug } from "../utils/strings.js";
import { CONFIG_FLAG_ARGS } from "../command-args.js";
import {
  ensureProjectSdk,
  loadRemoteProjectIdentity,
} from "../services/api/index.js";
import { materializeWorkspaceProject } from "../services/project/materialize-workspace.js";
import { ensureLocalMaintainerSnapshot } from "../services/project/local-maintainer-registry.js";
import { createUuidV7 } from "../utils/uuid-v7.js";

export default defineCommand({
  meta: {
    name: "new",
    description: "Create a new game and scaffold a local workspace",
  },
  args: {
    slug: { type: "positional", description: "Game slug", required: true },
    description: {
      type: "string",
      description: "Short description of the game to create",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Delete existing game with the same slug before creating",
      default: false,
    },
    ...CONFIG_FLAG_ARGS,
  },
  async run({ args }) {
    const parsedArgs = parseNewCommandArgs(args);
    const slugInput = parsedArgs.slug;
    const description = parsedArgs.description.trim();

    const normalizedSlug = normalizeSlug(slugInput);
    const projectId = createUuidV7();
    if (!normalizedSlug) {
      throw new Error("Slug must contain at least one alphanumeric character.");
    }
    if (normalizedSlug !== slugInput) {
      consola.info(`Normalized slug to '${normalizedSlug}'.`);
    }

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
    const localMaintainerRegistry = await ensureLocalMaintainerSnapshot(
      config.apiBaseUrl,
    );

    const identity = await loadRemoteProjectIdentity();
    const project = await ensureProjectSdk({
      projectId,
      slug: normalizedSlug,
      description,
      updateAlias: Boolean(parsedArgs.force),
    });

    const blankManifest: GameTopologyManifest = {
      players: {
        minPlayers: 2,
        maxPlayers: 4,
        optimalPlayers: 4,
      },
      cardSets: [],
      zones: [],
      boardTemplates: [],
      boards: [],
      pieceTypes: [],
      pieceSeeds: [],
      dieTypes: [],
      dieSeeds: [],
      resources: [],
      setupOptions: [],
      setupProfiles: [],
    };

    consola.start("Scaffolding local workspace...");

    const targetDir = path.resolve(process.cwd(), project.slug);
    await materializeWorkspaceProject({
      targetDir,
      projectId,
      slug: project.slug,
      gameId: project.projectId,
      deploymentId: identity.deploymentId,
      ownerScopeId: identity.ownerScopeId,
      bindingKey: identity.bindingKey,
      remoteHeadDigest: project.head?.revisionDigest,
      apiBaseUrl: config.apiBaseUrl,
      webBaseUrl: config.webBaseUrl,
      manifest: blankManifest,
      ruleText: "",
      localMaintainerRegistry,
    });

    consola.success(`Created new project in ${targetDir}`);
    consola.info(
      "Next: edit your files, then run 'dreamboard sync' followed by 'dreamboard compile'.",
    );
  },
});
