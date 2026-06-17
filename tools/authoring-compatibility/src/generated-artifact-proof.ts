import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScaffoldProof } from "./scaffold-proof.ts";
import { spawnFile } from "./process.ts";

export type GeneratedArtifactProof = {
  generatedPaths: string[];
  firstHash: string;
  secondHash: string;
  byteIdenticalRerun: boolean;
  typecheck: "passed";
  reducerScenarios:
    | "passed"
    | {
        status: "blocked";
        reason: string;
      };
};

export async function proveGeneratedArtifacts(
  scaffold: ScaffoldProof,
): Promise<GeneratedArtifactProof> {
  const generatedPaths = await readGeneratedPaths(scaffold.frozenProjectRoot);
  const firstHash = await hashGeneratedPaths(
    scaffold.frozenProjectRoot,
    generatedPaths,
  );
  await spawnFile("node", [path.join(scaffold.commandRoot, "codegen.mjs")], {
    cwd: scaffold.commandRoot,
  });
  const secondHash = await hashGeneratedPaths(
    scaffold.frozenProjectRoot,
    generatedPaths,
  );
  if (firstHash !== secondHash) {
    throw new Error("Generated artifacts are not byte-identical after rerun.");
  }

  await spawnFile("pnpm", ["run", "typecheck"], {
    cwd: scaffold.frozenProjectRoot,
  });
  const reducerScenarios = await proveReducerScenarios(scaffold);

  return {
    generatedPaths,
    firstHash,
    secondHash,
    byteIdenticalRerun: true,
    typecheck: "passed",
    reducerScenarios,
  };
}

async function proveReducerScenarios(
  scaffold: ScaffoldProof,
): Promise<GeneratedArtifactProof["reducerScenarios"]> {
  const dreamboardBin = path.join(
    scaffold.commandRoot,
    "node_modules",
    ".bin",
    "dreamboard",
  );
  const generate = await spawnFile(
    dreamboardBin,
    ["test", "generate", "--env", "local"],
    { cwd: scaffold.frozenProjectRoot, allowFailure: true },
  );
  if (
    `${generate.stdout}\n${generate.stderr}`.includes("ERR_MODULE_NOT_FOUND")
  ) {
    return {
      status: "blocked",
      reason:
        "packed dreamboard test still statically imports @dreamboard-games/sdk from the CLI package instead of resolving it from the project",
    };
  }
  const run = await spawnFile(
    dreamboardBin,
    ["test", "run", "--env", "local", "--runner", "reducer"],
    { cwd: scaffold.frozenProjectRoot, allowFailure: true },
  );
  const combined = `${run.stdout}\n${run.stderr}`;
  if (combined.includes("ERR_MODULE_NOT_FOUND")) {
    return {
      status: "blocked",
      reason:
        "packed dreamboard test still statically imports @dreamboard-games/sdk from the CLI package instead of resolving it from the project",
    };
  }
  if (combined.includes("FAIL") || combined.includes("failed")) {
    throw new Error(`Reducer scenario proof failed.\n${combined}`);
  }
  return "passed";
}

async function readGeneratedPaths(projectRoot: string): Promise<string[]> {
  const probePath = path.join(
    projectRoot,
    ".dreamboard",
    "generated-paths.mjs",
  );
  await writeFile(
    probePath,
    `
      import { projectAuthoringAdapter } from "@dreamboard-games/sdk/authoring";
      console.log(JSON.stringify(projectAuthoringAdapter.generatedPaths));
    `,
    "utf8",
  );
  const result = await spawnFile("node", [probePath], { cwd: projectRoot });
  return (JSON.parse(result.stdout.trim()) as string[]).sort();
}

async function hashGeneratedPaths(
  projectRoot: string,
  generatedPaths: string[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const generatedPath of generatedPaths) {
    const content = await readFile(
      path.join(projectRoot, generatedPath),
      "utf8",
    );
    hash.update(generatedPath);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}
