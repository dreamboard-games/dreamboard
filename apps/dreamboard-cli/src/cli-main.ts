import { defineCommand, runMain, type CommandDef } from "citty";
import consola from "consola";
import cmdClone from "./commands/clone.js";
import cmdCompile from "./commands/compile.js";
import cmdConfig from "./commands/config.js";
import cmdDev from "./commands/dev.js";
import cmdJoin from "./commands/join.js";
import cmdLogin from "./commands/login.js";
import cmdLogout from "./commands/logout.js";
import cmdNew from "./commands/new.js";
import cmdPull from "./commands/pull.js";
import cmdStatus from "./commands/status.js";
import cmdSync from "./commands/sync.js";
import cmdTest from "./commands/test.js";
import { formatCliError, getCliErrorExitCode } from "./utils/errors.js";

// ---------------------------------------------------------------------------
// Global error handlers prevent runtime-specific stack previews from spilling
// into CLI output. Instead we emit a single clean error line.
// ---------------------------------------------------------------------------
type FatalErrorHandler = (error: unknown) => never;

function handleFatalError(error: unknown): never {
  const message = formatCliError(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(getCliErrorExitCode(error));
  throw error;
}

process.on("uncaughtException", handleFatalError);
process.on("unhandledRejection", handleFatalError);

consola.options.formatOptions.date = false;

const publicSubCommands = {
  new: cmdNew,
  clone: cmdClone,
  sync: cmdSync,
  compile: cmdCompile,
  pull: cmdPull,
  status: cmdStatus,
  dev: cmdDev,
  join: cmdJoin,
  test: cmdTest,
  login: cmdLogin,
  logout: cmdLogout,
  config: cmdConfig,
};

export type DreamboardSubCommand = CommandDef<any>;

type DreamboardCommandMap = Record<string, DreamboardSubCommand>;

function wrapCommandMapForCli(
  commands: DreamboardCommandMap,
  fatalErrorHandler: FatalErrorHandler,
): DreamboardCommandMap {
  return Object.fromEntries(
    Object.entries(commands).map(([name, command]) => [
      name,
      wrapCommandForCli(command, fatalErrorHandler),
    ]),
  );
}

export function wrapCommandForCli(
  command: DreamboardSubCommand,
  fatalErrorHandler: FatalErrorHandler = handleFatalError,
): DreamboardSubCommand {
  const subCommands = command.subCommands as DreamboardCommandMap | undefined;
  return {
    ...command,
    subCommands: subCommands
      ? wrapCommandMapForCli(subCommands, fatalErrorHandler)
      : undefined,
    run: command.run
      ? async (context) => {
          try {
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
      version: "0.1.29",
      description: "Dreamboard CLI — game development platform",
    },
    subCommands,
  });

  void runMain(main).catch(handleFatalError);
}
