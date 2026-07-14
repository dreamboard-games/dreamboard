#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const packageRoot = path.resolve(import.meta.dirname, "..");
const sdkTarball = process.env.AUTHORING_SDK_TARBALL;
const outputDir = path.resolve(
  process.env.AUTHORING_CANDIDATE_DIR ??
    path.join(repoRoot, "build", "authoring-candidates"),
);

if (!sdkTarball) {
  throw new Error("AUTHORING_SDK_TARBALL is required.");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function sha512(bytes) {
  return {
    sha512: createHash("sha512").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

async function gitDirArg() {
  try {
    if ((await stat(path.join(repoRoot, ".here"))).isDirectory()) {
      return ".here";
    }
  } catch {
    // Fall back to the standard checkout layout.
  }
  return ".git";
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
run("pnpm", ["--dir", "packages/api-client", "build"], {
  stdio: "inherit",
});
run("pnpm", [
  "--dir",
  "packages/api-client",
  "pack",
  "--pack-destination",
  outputDir,
]);
const tarballs = (await readdir(outputDir))
  .filter((entry) => entry.endsWith(".tgz"))
  .map((entry) => path.join(outputDir, entry));
if (tarballs.length !== 1) {
  throw new Error(
    `Expected one API-client tarball in ${outputDir}; found ${tarballs.length}.`,
  );
}
const apiClientTarball = tarballs[0];
const consumerRoot = await mkdtemp(
  path.join(tmpdir(), "dreamboard-api-client-authoring-"),
);

try {
  await writeFile(
    path.join(consumerRoot, "package.json"),
    `${JSON.stringify(
      { name: "api-client-authoring-proof", private: true, type: "module" },
      null,
      2,
    )}\n`,
  );
  run(
    "pnpm",
    [
      "add",
      "--ignore-scripts",
      "--save-exact",
      path.resolve(sdkTarball),
      apiClientTarball,
    ],
    { cwd: consumerRoot },
  );

  const probePath = path.join(consumerRoot, "check-authoring.mjs");
  await writeFile(
    probePath,
    `
      import { createHash } from "node:crypto";
      import { readFile } from "node:fs/promises";
      import path from "node:path";
      import { fileURLToPath } from "node:url";
      import { projectAuthoringAdapter } from "@dreamboard-games/sdk/authoring";
      import { zGameTopologyManifest } from "@dreamboard-games/api-client/zod.gen";

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
      const zodEntry = fileURLToPath(
        import.meta.resolve("@dreamboard-games/api-client/zod.gen"),
      );
      const sdkAuthoringEntry = fileURLToPath(
        import.meta.resolve("@dreamboard-games/sdk/authoring"),
      );
      const apiManifest = JSON.parse(
        await readFile(path.resolve(path.dirname(zodEntry), "..", "package.json"), "utf8"),
      );
      const sdkManifest = JSON.parse(
        await readFile(path.resolve(path.dirname(sdkAuthoringEntry), "../..", "package.json"), "utf8"),
      );
      for (const [name, version] of Object.entries(apiManifest.dependencies ?? {})) {
        if (version.startsWith("workspace:") || version.startsWith("file:")) {
          throw new Error("Packed dependency " + name + " is not registry-installable: " + version);
        }
      }
      let accepted = 0;
      let rejected = 0;
      for (const fixture of projectAuthoringAdapter.manifestConformanceCases) {
        const result = zGameTopologyManifest.safeParse(fixture.manifest);
        const expectedTransportValid =
          fixture.expected.transportValid ??
          !fixture.expected.diagnosticCodes?.includes(
            "MANUAL_CARD_SET_DEFAULT_HOME_REQUIRED",
          );
        if (result.success !== expectedTransportValid) {
          throw new Error(fixture.id + " packed Zod transport mismatch");
        }
        if (result.success) accepted += 1;
        else rejected += 1;
      }
      console.log(JSON.stringify({
        packageName: apiManifest.name,
        packageVersion: apiManifest.version,
        sdkName: sdkManifest.name,
        sdkVersion: sdkManifest.version,
        fixtureCount: projectAuthoringAdapter.manifestConformanceCases.length,
        fixtureDigest: createHash("sha256")
          .update(stableJson(projectAuthoringAdapter.manifestConformanceCases))
          .digest("hex"),
        transportAccepted: accepted,
        transportRejected: rejected,
      }));
    `,
  );
  const runtimeProof = JSON.parse(
    run("node", [probePath], { cwd: consumerRoot }),
  );

  await writeFile(
    path.join(consumerRoot, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["contract.ts"],
      },
      null,
      2,
    )}\n`,
  );
  const validCardSets = `
    import type {
      ManualCardSetDefinition,
      PresetCardSetDefinition,
    } from "@dreamboard-games/api-client/types.gen";
    const manual: ManualCardSetDefinition = {
      id: "cards",
      name: "Cards",
      type: "manual",
      cardSchema: { properties: {} },
      defaultHome: { type: "detached" },
      cards: [],
    };
    const preset: PresetCardSetDefinition = {
      id: "standard-cards",
      presetId: "standard-52",
      name: "Standard Cards",
      type: "preset",
      defaultHome: { type: "detached" },
    };
    void manual;
    void preset;
  `;
  await writeFile(path.join(consumerRoot, "contract.ts"), validCardSets);
  run("tsc", ["-p", path.join(consumerRoot, "tsconfig.json")], {
    cwd: consumerRoot,
  });

  for (const [kind, source] of [
    [
      "manual",
      validCardSets.replace(
        '      defaultHome: { type: "detached" },\n      cards: [],',
        "      cards: [],",
      ),
    ],
    [
      "preset",
      validCardSets.replace(
        '      defaultHome: { type: "detached" },\n    };\n    void manual;',
        "    };\n    void manual;",
      ),
    ],
  ]) {
    await writeFile(path.join(consumerRoot, "contract.ts"), source);
    const invalidCompile = spawnSync(
      "tsc",
      ["-p", path.join(consumerRoot, "tsconfig.json")],
      { cwd: consumerRoot, encoding: "utf8" },
    );
    if (
      invalidCompile.status === 0 ||
      !`${invalidCompile.stdout ?? ""}${invalidCompile.stderr ?? ""}`.includes(
        "defaultHome",
      )
    ) {
      throw new Error(
        `Packed API-client declarations did not reject a ${kind} card set without defaultHome.`,
      );
    }
  }

  const packageManifest = JSON.parse(
    await readFile(path.join(packageRoot, "package.json"), "utf8"),
  );
  const tarballBytes = await readFile(apiClientTarball);
  const sdkTarballBytes = await readFile(path.resolve(sdkTarball));
  const gitDir = await gitDirArg();
  const receipt = {
    schemaVersion: 1,
    package: {
      name: packageManifest.name,
      version: packageManifest.version,
      tarball: path.basename(apiClientTarball),
      ...sha512(tarballBytes),
    },
    sdkInput: {
      name: runtimeProof.sdkName,
      version: runtimeProof.sdkVersion,
      ...sha512(sdkTarballBytes),
    },
    packedRuntime: runtimeProof,
    packedTypeDeclarations: {
      validManualCardSet: "passed",
      validPresetCardSet: "passed",
      manualMissingDefaultHomeRejected: "passed",
      presetMissingDefaultHomeRejected: "passed",
    },
    source: {
      revision: run("git", [
        "-c",
        "core.fsmonitor=false",
        `--git-dir=${gitDir}`,
        "--work-tree=.",
        "rev-parse",
        "HEAD",
      ]),
      dirty:
        run("git", [
          "-c",
          "core.fsmonitor=false",
          `--git-dir=${gitDir}`,
          "--work-tree=.",
          "status",
          "--short",
          "--untracked-files=no",
        ]).length > 0,
    },
  };
  await writeFile(
    path.join(outputDir, "api-client-authoring-candidate-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  console.log(`Retained API-client authoring candidate in ${outputDir}`);
} finally {
  await rm(consumerRoot, { recursive: true, force: true });
}
