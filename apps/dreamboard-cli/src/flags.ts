import { z } from "zod";

const configFlagsSchema = z.object({
  env: z.enum(["local", "staging", "prod"]).optional(),
  token: z.string().optional(),
});

const ruleInputFlagsSchema = z.object({
  "rule-file": z.string().optional(),
  rule: z.string().optional(),
});

const playerCountFlagsSchema = z.object({
  players: z.string().optional(),
  "player-count": z.string().optional(),
});

const newCommandArgsSchema = configFlagsSchema.extend({
  slug: z.string().min(1),
  description: z.string().min(1),
  force: z.boolean().default(false),
});

const cloneCommandArgsSchema = configFlagsSchema.extend({
  slug: z.string().min(1),
});

const queryCommandArgsSchema = configFlagsSchema.extend({
  title: z.string().min(1),
});

const pullCommandArgsSchema = configFlagsSchema.extend({
  force: z.boolean().default(false),
});

const syncCommandArgsSchema = configFlagsSchema.extend({
  force: z.boolean().default(false),
  yes: z.boolean().default(false),
});

const compileCommandArgsSchema = configFlagsSchema.extend({
  debug: z.boolean().default(false),
  "skip-local-check": z.boolean().default(false),
});

const statusCommandArgsSchema = configFlagsSchema.extend({
  json: z.boolean().default(false),
});

const devCommandArgsSchema = configFlagsSchema.extend({
  seed: z.string().optional(),
  "setup-profile": z.string().optional(),
  players: z.string().optional(),
  "player-count": z.string().optional(),
  debug: z.boolean().default(false),
  resume: z.string().optional(),
  "from-scenario": z.string().optional(),
  "new-session": z.boolean().default(false),
  open: z.boolean().default(false),
  port: z.string().optional(),
  host: z.union([z.string(), z.boolean()]).optional(),
  "allowed-host": z.string().optional(),
});

const joinCommandArgsSchema = configFlagsSchema.extend({
  session: z.string().min(1).optional(),
  player: z.string().min(1),
  "raw-events": z.boolean().default(false),
});

const loginCommandArgsSchema = configFlagsSchema;

const configCommandArgsSchema = configFlagsSchema.extend({
  action: z.string().optional().default("show"),
  scope: z.enum(["global", "workspace"]).optional().default("global"),
});

const authCommandArgsSchema = z.object({
  action: z.enum(["set", "clear", "login", "env", "status", "git-credential"]),
  tokenValue: z.string().optional(),
  token: z.string().optional(),
  jwt: z.boolean().optional(),
  env: z.enum(["local", "staging", "prod"]).optional(),
});

export type ConfigFlags = z.infer<typeof configFlagsSchema>;
export type RuleInputFlags = z.infer<typeof ruleInputFlagsSchema>;
export type PlayerCountFlags = z.infer<typeof playerCountFlagsSchema>;

export type NewCommandArgs = z.infer<typeof newCommandArgsSchema>;
export type CloneCommandArgs = z.infer<typeof cloneCommandArgsSchema>;
export type QueryCommandArgs = z.infer<typeof queryCommandArgsSchema>;
export type PullCommandArgs = z.infer<typeof pullCommandArgsSchema>;
export type SyncCommandArgs = z.infer<typeof syncCommandArgsSchema>;
export type CompileCommandArgs = z.infer<typeof compileCommandArgsSchema>;
export type StatusCommandArgs = z.infer<typeof statusCommandArgsSchema>;
export type DevCommandArgs = z.infer<typeof devCommandArgsSchema>;
export type JoinCommandArgs = z.infer<typeof joinCommandArgsSchema>;
export type LoginCommandArgs = z.infer<typeof loginCommandArgsSchema>;
export type ConfigCommandArgs = z.infer<typeof configCommandArgsSchema>;
export type AuthCommandArgs = z.infer<typeof authCommandArgsSchema>;

function parseArgs<TOutput>(
  commandName: string,
  schema: z.ZodType<TOutput>,
  args: unknown,
): TOutput {
  const parsed = schema.safeParse(args);
  if (parsed.success) {
    return parsed.data;
  }

  const details = parsed.error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "args";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
  throw new Error(`Invalid arguments for '${commandName}': ${details}`);
}

export function parseConfigFlags(args: unknown): ConfigFlags {
  return parseArgs("config-flags", configFlagsSchema, args);
}

export function parseRuleInputFlags(args: unknown): RuleInputFlags {
  return parseArgs("rule-flags", ruleInputFlagsSchema, args);
}

export function parsePlayerCountFlags(args: unknown): PlayerCountFlags {
  return parseArgs("player-count", playerCountFlagsSchema, args);
}

export function parseNewCommandArgs(args: unknown): NewCommandArgs {
  return parseArgs("new", newCommandArgsSchema, args);
}

export function parseCloneCommandArgs(args: unknown): CloneCommandArgs {
  return parseArgs("clone", cloneCommandArgsSchema, args);
}

export function parseQueryCommandArgs(args: unknown): QueryCommandArgs {
  return parseArgs("query", queryCommandArgsSchema, args);
}

export function parsePullCommandArgs(args: unknown): PullCommandArgs {
  return parseArgs("pull", pullCommandArgsSchema, args);
}

export function parseSyncCommandArgs(args: unknown): SyncCommandArgs {
  return parseArgs("sync", syncCommandArgsSchema, args);
}

export function parseCompileCommandArgs(args: unknown): CompileCommandArgs {
  return parseArgs("compile", compileCommandArgsSchema, args);
}

export function parseStatusCommandArgs(args: unknown): StatusCommandArgs {
  return parseArgs("status", statusCommandArgsSchema, args);
}

export function parseDevCommandArgs(args: unknown): DevCommandArgs {
  return parseArgs("dev", devCommandArgsSchema, args);
}

export function parseJoinCommandArgs(args: unknown): JoinCommandArgs {
  return parseArgs("join", joinCommandArgsSchema, args);
}

export function parseLoginCommandArgs(args: unknown): LoginCommandArgs {
  return parseArgs("login", loginCommandArgsSchema, args);
}

export function parseConfigCommandArgs(args: unknown): ConfigCommandArgs {
  return parseArgs("config", configCommandArgsSchema, args);
}

export function parseAuthCommandArgs(args: unknown): AuthCommandArgs {
  return parseArgs("auth", authCommandArgsSchema, args);
}
