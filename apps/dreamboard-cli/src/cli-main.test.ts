import { describe, expect, test } from "bun:test";
import type { CommandDef } from "citty";
import { publicSubCommands } from "./cli-main.js";

const ALLOWED_PUBLIC_COMMAND_IDS = [
  "auth.login",
  "auth.logout",
  "auth.status",
  "project.create",
  "project.clone",
  "project.status",
  "verify",
  "test",
  "dev",
  "build",
  "preview",
  "release.publish",
  "release.current",
  "doctor",
  "feedback.submit",
] as const;

const HIDDEN_COMMAND_IDS = new Set(["auth.git-credential"]);

function collectPublicCommandIds(
  commands: Record<string, CommandDef<any>>,
  prefix: readonly string[] = [],
): string[] {
  const ids: string[] = [];
  for (const [name, command] of Object.entries(commands).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const path = [...prefix, name];
    const subCommands = command.subCommands as
      | Record<string, CommandDef<any>>
      | undefined;
    if (subCommands && Object.keys(subCommands).length > 0) {
      ids.push(...collectPublicCommandIds(subCommands, path));
      continue;
    }
    const id = path.join(".");
    if (!HIDDEN_COMMAND_IDS.has(id)) {
      ids.push(id);
    }
  }
  return ids;
}

describe("public command tree", () => {
  test("matches the Phase 8 allowlist exactly", () => {
    expect(collectPublicCommandIds(publicSubCommands)).toEqual(
      [...ALLOWED_PUBLIC_COMMAND_IDS].sort(),
    );
  });
});
