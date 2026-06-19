import { SystemGit } from "@dreamboard-games/cli-core";
import { resolveProjectContext } from "../config/resolve.js";
import type { ConfigFlags } from "../flags.js";

export async function resolveCommitScopedProjectContext(
  flags: ConfigFlags,
  revision: string,
  opts?: { requireAuth?: boolean },
) {
  const context = await resolveProjectContext(flags, opts);
  const commitOid = await new SystemGit().resolveCommit(
    context.projectRoot,
    revision,
  );
  return {
    ...context,
    commitOid,
  };
}

export function printJsonOrSummary(options: {
  json: boolean;
  value: unknown;
  summary: string;
}): void {
  if (options.json) {
    console.log(JSON.stringify(options.value, null, 2));
    return;
  }
  console.log(options.summary);
}
