import { readFile } from "node:fs/promises";
import consola from "consola";
import type { CommandDef } from "citty";
import type { ConfigFlags } from "../flags.js";
import type { ProjectConfig, ResolvedConfig } from "../types.js";
import { resolveProjectContext } from "../config/resolve.js";
import { assertCompilerPortableDependencies } from "../services/project/dependency-portability.js";

type VerificationMode = "preflight" | "verify" | "fin" | "cloud-local";

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
  const { materializeWorkspaceProject } = await import(
    "../services/project/materialize-workspace.js"
  );
  const input = JSON.parse(
    await readFile(inputPath, "utf8"),
  ) as Parameters<typeof materializeWorkspaceProject>[0];
  await materializeWorkspaceProject({
    ...input,
    agentManaged: true,
    workspacePrepared: true,
    allowCreateGame: false,
    installDependencies: false,
  });
  consola.success(`Prepared workspace in ${input.targetDir}`);
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

  if (process.env.DREAMBOARD_AGENT_FINAL_SYNC_VERIFY === "1") {
    await runFullBackendConnectedVerification(parsedFlags);
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

async function runFullBackendConnectedVerification(
  parsedFlags: ConfigFlags,
): Promise<void> {
  const [{ default: cmdSync }, { default: cmdCompile }, { default: cmdTest }] =
    await Promise.all([
      import("../commands/sync.js"),
      import("../commands/compile.js"),
      import("../commands/test.js"),
    ]);
  await runCommandDefinition(cmdSync, { ...parsedFlags, force: true });
  await runCommandDefinition(cmdCompile, parsedFlags);
  await runCommandDefinition(cmdTest, parsedFlags);
}

async function runCommandDefinition(
  command: CommandDef<any>,
  args: Record<string, unknown>,
) {
  if (!command.run) {
    throw new Error("Verifier command is missing a runnable step.");
  }
  await command.run({ args, rawArgs: [], cmd: command } as any);
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
  } = await import(
    "../services/testing/reducer-native-test-harness.js"
  );

  if (await isReducerNativeTestingWorkspace(projectRoot)) {
    const { bases } = await generateReducerNativeArtifacts({
      projectRoot,
      gameId: projectConfig.gameId,
      compiledResultId: projectConfig.compile?.latestSuccessful?.resultId,
    });
    const summary = await runReducerNativeScenarios({
      projectRoot,
      projectConfig,
      resolvedConfig: config,
      runner: "reducer",
      gameId: projectConfig.gameId,
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
