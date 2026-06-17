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
  reducerScenarios: "passed";
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
  const verifierEntry = path.join(
    scaffold.commandRoot,
    "node_modules",
    "@dreamboard-games",
    "cli",
    "dist",
    "agent-verifier",
    "agent-workspace-verifier.mjs",
  );
  const localProofEnv = {
    ...process.env,
    DREAMBOARD_AGENT_TOKEN: "authoring-compatibility-local-proof",
  };
  const verification = await spawnFile(
    process.execPath,
    [verifierEntry, "cloud-local", "--env", "local"],
    {
      cwd: scaffold.frozenProjectRoot,
      env: localProofEnv,
      allowFailure: true,
    },
  );
  const combined = `${verification.stdout}\n${verification.stderr}`;
  if (combined.includes("ERR_MODULE_NOT_FOUND")) {
    throw new Error(
      "Packed dreamboard test could not resolve reducer helpers from the active project SDK package.",
    );
  }
  if (
    verification.exitCode !== 0 ||
    combined.includes("FAIL") ||
    combined.includes("failed") ||
    !combined.includes("reducer-native base state") ||
    !combined.includes("cloud-local verification passed")
  ) {
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
