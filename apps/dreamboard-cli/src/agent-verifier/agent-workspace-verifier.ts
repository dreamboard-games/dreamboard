import { readFile } from "node:fs/promises";
import consola from "consola";
import type { GameTopologyManifest } from "@dreamboard-games/sdk/types";
import type { ConfigFlags } from "../flags.js";
import type {
  AgentMaintainerPackageSourceV1,
  ProjectConfig,
  ResolvedConfig,
} from "../types.js";
import { resolveProjectContext } from "../config/resolve.js";
import { assertCompilerPortableDependencies } from "../services/project/dependency-portability.js";
import type { MaterializeWorkspaceProjectInput } from "../services/project/materialize-workspace.js";

type VerificationMode = "preflight" | "verify" | "fin" | "cloud-local";
type PreparedWorkspaceManifestV2 = {
  version: 2;
  workspaceId?: string;
  workspaceSlug?: string;
  projectId?: string;
  deploymentId?: string;
  ownerScopeId?: string;
  bindingKey?: string;
  gameInstanceId?: string;
  jobId?: string;
  environmentManifest: {
    apiBaseUrl: string;
    webBaseUrl: string;
    [key: string]: unknown;
  };
  maintainerPackageSource?: AgentMaintainerPackageSourceV1;
  [key: string]: unknown;
};
type MaterializePreparedWorkspaceInputV2 = {
  preparedWorkspace: PreparedWorkspaceManifestV2;
  destinationDirectory?: string;
  targetDir?: string;
  slug?: string;
  projectId?: string;
  deploymentId?: string;
  ownerScopeId?: string;
  bindingKey?: string;
  jobId?: string;
  apiBaseUrl?: string;
  webBaseUrl?: string;
  ruleText?: string;
  manifest?: GameTopologyManifest;
  environmentManifest?: Record<string, unknown>;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "--help" || command === "help") {
    printHelp();
    return;
  }
  if (command === "materialize-prepared-workspace") {
    if (args.includes("--help")) {
      printHelp();
      return;
    }
    await materializePreparedWorkspace(args);
    return;
  }
  await verifyAgentWorkspace(command ?? "verify", args);
}

function printHelp() {
  console.log(`Dreamboard agent workspace verifier

Usage:
  agent-workspace-verifier materialize-prepared-workspace --input <path>
  agent-workspace-verifier preflight [--env local|staging|prod]
  agent-workspace-verifier verify [--env local|staging|prod]
  agent-workspace-verifier fin [--env local|staging|prod]
`);
}

async function materializePreparedWorkspace(args: string[]) {
  const inputPath = readRequiredOption(args, "--input");
  const { materializeWorkspaceProject } =
    await import("../services/project/materialize-workspace.js");
  const input = normalizeMaterializePreparedWorkspaceInput(
    JSON.parse(await readFile(inputPath, "utf8")),
  );
  await materializeWorkspaceProject({
    ...input,
    agentManaged: true,
    workspacePrepared: true,
    allowCreateGame: false,
    installDependencies: false,
  });
  consola.success(`Prepared workspace in ${input.targetDir}`);
}

function normalizeMaterializePreparedWorkspaceInput(
  rawInput: unknown,
): MaterializeWorkspaceProjectInput {
  const input = assertObject(
    rawInput,
    "materialize input",
  ) as Partial<MaterializePreparedWorkspaceInputV2> & Record<string, unknown>;
  const preparedWorkspace = input.preparedWorkspace;
  if (!preparedWorkspace) {
    return input as MaterializeWorkspaceProjectInput;
  }

  const prepared = assertPreparedWorkspaceV2(preparedWorkspace);
  const targetDir =
    optionalString(input.targetDir) ??
    optionalString(input.destinationDirectory);
  if (!targetDir) {
    throw new Error(
      "Prepared workspace materialization requires targetDir or destinationDirectory.",
    );
  }

  const environmentManifest =
    asRecord(input.environmentManifest) ?? prepared.environmentManifest;
  const apiBaseUrl =
    optionalString(input.apiBaseUrl) ?? prepared.environmentManifest.apiBaseUrl;
  const webBaseUrl =
    optionalString(input.webBaseUrl) ?? prepared.environmentManifest.webBaseUrl;
  const workspaceId =
    optionalString(prepared.workspaceId) ??
    optionalString(prepared.gameInstanceId) ??
    optionalString(input.projectId);
  const projectId =
    optionalString(input.projectId) ??
    optionalString(prepared.projectId) ??
    workspaceId;
  const slug =
    optionalString(input.slug) ??
    optionalString(prepared.workspaceSlug) ??
    optionalString(prepared.workspaceId) ??
    projectId;

  if (!projectId || !slug) {
    throw new Error(
      "Prepared workspace materialization requires projectId/slug or prepared workspace identifiers.",
    );
  }
  const deploymentId =
    optionalString(input.deploymentId) ?? optionalString(prepared.deploymentId);
  const ownerScopeId =
    optionalString(input.ownerScopeId) ?? optionalString(prepared.ownerScopeId);
  const bindingKey =
    optionalString(input.bindingKey) ??
    optionalString(prepared.bindingKey) ??
    (deploymentId && ownerScopeId
      ? `${deploymentId}:${ownerScopeId}`
      : undefined);

  if (!deploymentId || !ownerScopeId) {
    throw new Error(
      "Prepared workspace materialization requires deploymentId and ownerScopeId.",
    );
  }

  return {
    targetDir,
    projectId,
    slug,
    deploymentId,
    ownerScopeId,
    bindingKey,
    apiBaseUrl,
    webBaseUrl,
    manifest:
      (input.manifest as GameTopologyManifest | undefined) ?? emptyManifest(),
    ruleText: optionalString(input.ruleText) ?? "",
    jobId: optionalString(input.jobId) ?? optionalString(prepared.jobId),
    environmentManifest,
    maintainerPackageSource: prepared.maintainerPackageSource,
  };
}

function assertPreparedWorkspaceV2(
  value: unknown,
): PreparedWorkspaceManifestV2 {
  const prepared = assertObject(value, "preparedWorkspace");
  if (prepared.version !== 2) {
    throw new Error(
      `Expected preparedWorkspace.version to be 2. Received: ${String(prepared.version)}`,
    );
  }
  const environmentManifest = assertObject(
    prepared.environmentManifest,
    "preparedWorkspace.environmentManifest",
  );
  const apiBaseUrl = optionalString(environmentManifest.apiBaseUrl);
  const webBaseUrl = optionalString(environmentManifest.webBaseUrl);
  if (!apiBaseUrl || !webBaseUrl) {
    throw new Error(
      "preparedWorkspace.environmentManifest requires apiBaseUrl and webBaseUrl.",
    );
  }
  return {
    ...prepared,
    version: 2,
    environmentManifest: {
      ...environmentManifest,
      apiBaseUrl,
      webBaseUrl,
    },
    maintainerPackageSource: prepared.maintainerPackageSource as
      | AgentMaintainerPackageSourceV1
      | undefined,
  };
}

function assertObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function emptyManifest(): GameTopologyManifest {
  return {
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
}

async function verifyAgentWorkspace(rawMode: string, args: string[]) {
  const requestedMode = parseVerificationMode(rawMode);
  const parsedFlags = parseConfigArgs(args);
  const { projectRoot, projectConfig, config } =
    await resolveProjectContext(parsedFlags);
  await assertCompilerPortableDependencies({ projectRoot, projectConfig });

  if (requestedMode === "preflight") {
    consola.success("Agent workspace preflight passed.");
    return;
  }

  if (
    requestedMode === "cloud-local" ||
    requestedMode === "verify" ||
    requestedMode === "fin"
  ) {
    await runCloudLocalVerification(projectRoot, projectConfig, config);
    return;
  }

  throw new Error(
    "Agent workspaces now run cloud-local verification directly. Use `fin` only through the generated wrapper.",
  );
}

function parseVerificationMode(value: unknown): VerificationMode {
  if (
    value === "preflight" ||
    value === "verify" ||
    value === "fin" ||
    value === "cloud-local"
  ) {
    return value;
  }
  throw new Error(
    `Expected mode to be one of preflight, verify, fin, or cloud-local. Received: ${String(value)}`,
  );
}

function parseConfigArgs(args: string[]): ConfigFlags {
  const flags: ConfigFlags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--env") {
      const value = args[++index];
      if (value === "local" || value === "staging" || value === "prod") {
        flags.env = value;
        continue;
      }
      throw new Error(`Invalid --env value: ${String(value)}`);
    }
    if (arg === "--token") {
      flags.token = args[++index];
      continue;
    }
    if (arg === "--skip-install") {
      continue;
    }
    throw new Error(`Unknown verifier argument: ${arg}`);
  }
  return flags;
}

async function runCloudLocalVerification(
  projectRoot: string,
  projectConfig: ProjectConfig,
  config: ResolvedConfig,
): Promise<void> {
  const [
    { scaffoldStaticWorkspace },
    { loadManifest },
    { applyWorkspaceCodegen },
    { reconcileWorkspaceDependencies },
    { assertReducerContractPreflight },
    { getProjectLocalMaintainerRegistry },
  ] = await Promise.all([
    import("../services/project/static-scaffold.js"),
    import("../services/project/local-files.js"),
    import("../services/project/workspace-codegen.js"),
    import("../services/project/workspace-dependencies.js"),
    import("../services/project/reducer-contract-preflight.js"),
    import("../services/project/project-state.js"),
  ]);

  consola.start("Refreshing static scaffold...");
  await scaffoldStaticWorkspace(projectRoot, "update", {
    localMaintainerRegistry: getProjectLocalMaintainerRegistry(projectConfig),
  });

  consola.start("Applying workspace codegen...");
  const manifest = await loadManifest(projectRoot);
  await applyWorkspaceCodegen({ projectRoot, manifest });

  consola.start("Reconciling workspace dependencies...");
  await reconcileWorkspaceDependencies(projectRoot);

  consola.start("Validating reducer contract...");
  await assertReducerContractPreflight(projectRoot);

  const [{ runLocalTypecheck }, { assertReducerBundleSmoke }] =
    await Promise.all([
      import("../services/project/local-typecheck.js"),
      import("../services/project/reducer-bundle-preflight.js"),
    ]);

  consola.start("Running local typecheck...");
  const typecheckResult = await runLocalTypecheck(projectRoot);
  if (typecheckResult.skipped) {
    if (typecheckResult.output) consola.warn(typecheckResult.output);
  } else if (!typecheckResult.success) {
    if (typecheckResult.output) consola.error(typecheckResult.output);
    throw new Error(
      "Local typecheck failed. Fix the diagnostics before syncing.",
    );
  }

  consola.start("Smoke-testing reducer bundle...");
  await assertReducerBundleSmoke({ projectRoot, manifest });

  const {
    generateReducerNativeArtifacts,
    isReducerNativeTestingWorkspace,
    runReducerNativeScenarios,
  } = await import("../services/testing/reducer-native-test-harness.js");

  if (await isReducerNativeTestingWorkspace(projectRoot)) {
    const { bases } = await generateReducerNativeArtifacts({
      projectRoot,
      projectId: projectConfig.projectId,
      compiledResultId: projectConfig.compile?.latestSuccessful?.resultId,
    });
    const summary = await runReducerNativeScenarios({
      projectRoot,
      projectConfig,
      resolvedConfig: config,
      projectId: projectConfig.projectId,
      compiledResultId: projectConfig.compile?.latestSuccessful?.resultId,
    });
    if (summary.failed > 0) {
      const failures = summary.results
        .filter((result) => !result.success)
        .map((result) =>
          result.error
            ? `FAIL ${result.id}: ${result.error}`
            : `FAIL ${result.id}`,
        );
      throw new Error(
        [
          `Reducer-native verification failed: ${summary.failed} failed, ${summary.passed} passed.`,
          ...failures,
        ].join("\n"),
      );
    }
    consola.success(`Generated ${bases.length} reducer-native base state(s).`);
  }

  consola.success("Agent workspace cloud-local verification passed.");
}

function readRequiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
