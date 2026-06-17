import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ScaffoldProof } from "./scaffold-proof.ts";
import { spawnFile } from "./process.ts";

export type AdapterProof = {
  metadata: {
    sdkVersion: string;
    codegenVersion: string;
    manifestSchemaVersion: number;
    generatedArtifactSchemaVersion: number;
  };
  protocolVersion: number;
  conformanceCases: {
    total: number;
    valid: number;
    invalid: number;
  };
  materializedDigestMismatches: string[];
  incompatibleAdapterRejected: boolean;
};

export async function proveAdapter(
  scaffold: ScaffoldProof,
): Promise<AdapterProof> {
  const output = await runProjectProbe(
    scaffold.frozenProjectRoot,
    `
    import { createHash } from "node:crypto";
    import { projectAuthoringAdapter } from "@dreamboard-games/sdk/authoring";
    import sdkPackage from "@dreamboard-games/sdk/package.json" with { type: "json" };
    const stableJson = (value) => {
      if (value === undefined) return "null";
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
      return "{" + Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => JSON.stringify(key) + ":" + stableJson(entry))
        .join(",") + "}";
    };
    const sha256 = (value) => createHash("sha256").update(value).digest("hex");
    const cases = projectAuthoringAdapter.manifestConformanceCases;
    let valid = 0;
    let invalid = 0;
    const materializedDigestMismatches = [];
    for (const entry of cases) {
      const result = projectAuthoringAdapter.validateManifest(entry.manifest);
      const isValid = result.errors.length === 0;
      if (isValid !== entry.expected.valid) {
        throw new Error(entry.id + " validation expectation drifted");
      }
      if (isValid) valid += 1;
      else invalid += 1;
      if (entry.expected.valid && entry.expected.materializedSha256) {
        const materialized = projectAuthoringAdapter.materializeManifest(entry.manifest);
        if (sha256(stableJson(materialized)) !== entry.expected.materializedSha256) {
          materializedDigestMismatches.push(entry.id);
        }
      }
    }
    if (materializedDigestMismatches.length > 0) {
      throw new Error(
        "Materialized fixture digest mismatch: " +
          materializedDigestMismatches.join(", "),
      );
    }
    if (projectAuthoringAdapter.metadata.sdkVersion !== sdkPackage.version) {
      throw new Error("Adapter metadata SDK version does not match package metadata.");
    }
    console.log(JSON.stringify({
      metadata: projectAuthoringAdapter.metadata,
      protocolVersion: projectAuthoringAdapter.protocolVersion,
      conformanceCases: { total: cases.length, valid, invalid },
      materializedDigestMismatches
    }));
  `,
  );

  const incompatibleAdapterRejected =
    await proveIncompatibleAdapterRejected(scaffold);

  return {
    ...(JSON.parse(output.stdout.trim()) as Omit<
      AdapterProof,
      "incompatibleAdapterRejected"
    >),
    incompatibleAdapterRejected,
  };
}

async function proveIncompatibleAdapterRejected(
  scaffold: ScaffoldProof,
): Promise<boolean> {
  const incompatibleRoot = `${scaffold.frozenProjectRoot}-incompatible`;
  await rm(incompatibleRoot, { recursive: true, force: true });
  await mkdir(incompatibleRoot, { recursive: true });
  await spawnFile("cp", [
    "-R",
    `${scaffold.frozenProjectRoot}/.`,
    incompatibleRoot,
  ]);
  const sdkRoot = path.join(
    incompatibleRoot,
    "node_modules",
    "@dreamboard-games",
    "sdk",
  );
  await rm(sdkRoot, { recursive: true, force: true });
  await mkdir(path.join(sdkRoot, "dist", "authoring"), { recursive: true });
  await writeFile(
    path.join(sdkRoot, "package.json"),
    JSON.stringify(
      {
        name: "@dreamboard-games/sdk",
        version: "0.0.0-incompatible",
        type: "module",
        exports: {
          "./authoring": "./dist/authoring/index.js",
          "./package.json": "./package.json",
        },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(sdkRoot, "dist", "authoring", "index.js"),
    "export const projectAuthoringAdapter = { protocolVersion: 999, metadata: {} };\n",
  );
  const result = await spawnFile(
    "node",
    [
      "-e",
      `
        import { applyWorkspaceCodegen } from ${JSON.stringify(
          path.join(
            scaffold.commandRoot,
            "node_modules",
            "@dreamboard-games",
            "cli",
            "dist",
            "authoring-compatibility-internal.js",
          ),
        )};
        await applyWorkspaceCodegen({
          projectRoot: ${JSON.stringify(incompatibleRoot)},
          manifest: {
            players: { minPlayers: 2, maxPlayers: 2, optimalPlayers: 2 },
            cardSets: [], zones: [], boardTemplates: [], boards: [],
            pieceTypes: [], pieceSeeds: [], dieTypes: [], dieSeeds: [],
            resources: [], setupOptions: [], setupProfiles: []
          }
        });
      `,
    ],
    { allowFailure: true },
  );
  const combined = `${result.stdout}\n${result.stderr}`;
  await rm(incompatibleRoot, { recursive: true, force: true });
  return combined.includes("AUTHORING_PROTOCOL_UNSUPPORTED");
}

async function runProjectProbe(projectRoot: string, source: string) {
  const probePath = path.join(projectRoot, ".dreamboard", "adapter-proof.mjs");
  await writeFile(probePath, source, "utf8");
  return spawnFile("node", [probePath], { cwd: projectRoot });
}
