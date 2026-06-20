import { readFileSync } from "node:fs";
import { defineCommand, runMain, type CommandDef } from "citty";
import consola from "consola";
import cmdAuth from "./commands/auth.js";
import cmdBuild from "./commands/build.js";
import cmdDev from "./commands/dev.js";
import cmdDoctor from "./commands/doctor.js";
import cmdPreview from "./commands/preview.js";
import cmdProject from "./commands/project.js";
import cmdRelease from "./commands/release.js";
import cmdTest from "./commands/test.js";
import cmdVerify from "./commands/verify.js";
import { formatCliError, getCliErrorExitCode } from "./utils/errors.js";
import {
  commandPathToId,
  consumeMachineOutputMode,
  emitMachineFailureAndExit,
  runWithMachineOutput,
  type MachineOutputContext,
} from "./machine-output.js";

// ---------------------------------------------------------------------------
// Global error handlers prevent runtime-specific stack previews from spilling
// into CLI output. Instead we emit a single clean error line.
// ---------------------------------------------------------------------------
type FatalErrorHandler = (error: unknown) => never;

let machineOutputContext: MachineOutputContext | null = null;

function readCliVersion(): string {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };

  if (typeof packageJson.version !== "string") {
    throw new Error("Unable to read Dreamboard CLI version from package.json.");
  }

  return packageJson.version;
}

function handleFatalError(error: unknown): never {
  if (machineOutputContext) {
    emitMachineFailureAndExit(
      machineOutputContext,
      commandPathToId(process.argv.slice(2)),
      error,
    );
  }
  const message = formatCliError(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(getCliErrorExitCode(error));
  throw error;
}

process.on("uncaughtException", handleFatalError);
process.on("unhandledRejection", handleFatalError);

consola.options.formatOptions.date = false;

const cliVersion = readCliVersion();

export const publicSubCommands = {
  auth: cmdAuth,
  project: cmdProject,
  verify: cmdVerify,
  test: cmdTest,
  dev: cmdDev,
  build: cmdBuild,
  preview: cmdPreview,
  release: cmdRelease,
  doctor: cmdDoctor,
};

export type DreamboardSubCommand = CommandDef<any>;

type DreamboardCommandMap = Record<string, DreamboardSubCommand>;

function wrapCommandMapForCli(
  commands: DreamboardCommandMap,
  fatalErrorHandler: FatalErrorHandler,
  parentPath: readonly string[] = [],
): DreamboardCommandMap {
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      wrapCommandForCli(command, fatalErrorHandler, [...parentPath, name]),
    ]),
  );
}

export function wrapCommandForCli(
  command: DreamboardSubCommand,
  fatalErrorHandler: FatalErrorHandler = handleFatalError,
  commandPath: readonly string[] = [],
): DreamboardSubCommand {
  const subCommands = command.subCommands as DreamboardCommandMap | undefined;
  return {
    ...command,
    subCommands: subCommands
      ? wrapCommandMapForCli(subCommands, fatalErrorHandler, commandPath)
      : undefined,
    run: command.run
      ? async (context) => {
          try {
            if (machineOutputContext) {
              await runWithMachineOutput(
                machineOutputContext,
                commandPathToId(process.argv.slice(2)),
                async () => {
                  await command.run?.(context);
                },
              );
              return;
            }
            return await command.run?.(context);
          } catch (error) {
            fatalErrorHandler(error);
          }
        }
      : undefined,
  };
}

export function runDreamboardCli(
  internalSubCommands: Record<string, DreamboardSubCommand> = {},
): void {
  machineOutputContext = consumeMachineOutputMode(process.argv);
  const subCommands = wrapCommandMapForCli(
    {
      ...publicSubCommands,
      ...internalSubCommands,
    },
    handleFatalError,
  );

  const main = defineCommand({
    meta: {
      name: "dreamboard",
      version: cliVersion,
      description: "Dreamboard CLI — game development platform",
    },
    subCommands,
  });

  void runMain(main).catch(handleFatalError);
}
