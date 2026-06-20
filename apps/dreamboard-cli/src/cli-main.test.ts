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
] as const;

const ALLOWED_HIDDEN_COMMAND_IDS = ["auth.git-credential"] as const;
const HIDDEN_COMMAND_IDS = new Set<string>(ALLOWED_HIDDEN_COMMAND_IDS);

function collectLeafCommandIds(
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
      ids.push(...collectLeafCommandIds(subCommands, path));
      continue;
    }
    ids.push(path.join("."));
  }
  return ids;
}

describe("public command tree", () => {
  test("matches the Phase 8 public allowlist with only declared hidden protocol commands", () => {
    const leafCommandIds = collectLeafCommandIds(publicSubCommands);
    const hiddenCommandIds = leafCommandIds.filter((id) =>
      HIDDEN_COMMAND_IDS.has(id),
    );
    const publicCommandIds = leafCommandIds.filter(
      (id) => !HIDDEN_COMMAND_IDS.has(id),
    );

    expect(hiddenCommandIds).toEqual([...ALLOWED_HIDDEN_COMMAND_IDS].sort());
    expect(publicCommandIds).toEqual(
      [...ALLOWED_PUBLIC_COMMAND_IDS].sort(),
    );
  });
});
