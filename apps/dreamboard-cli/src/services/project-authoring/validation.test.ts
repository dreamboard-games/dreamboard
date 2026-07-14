import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import type { ProjectAuthoringAdapterV1 } from "./contract.js";
import {
  validateGeneratedArtifacts,
  validateProjectAuthoringAdapter,
} from "./validation.js";

function adapter(
  overrides: Partial<ProjectAuthoringAdapterV1> = {},
): ProjectAuthoringAdapterV1 {
  return {
    protocolVersion: 1,
    metadata: {
      sdkVersion: "1.2.3",
      codegenVersion: "codegen-v1",
      manifestSchemaVersion: 2,
      generatedArtifactSchemaVersion: 1,
    },
    generatedPaths: ["app/game.ts"],
    manifestConformanceCases: [],
    validateManifest: () => ({ valid: true, errors: [], warnings: [] }),
    materializeManifest: (manifest) => manifest,
    generateWorkspaceArtifacts: () => [],
    ...overrides,
  };
}

function artifact(path: string) {
  const content = "export const generated = true;\n";
  return {
    path,
    ownership: "authoritative" as const,
    content,
    contentSha256: createHash("sha256").update(content).digest("hex"),
  };
}

describe("project authoring generated path validation", () => {
  test("rejects generated declarations outside the owned workspace roots", () => {
    expect(() =>
      validateProjectAuthoringAdapter(
        adapter({ generatedPaths: ["scripts/postinstall.mjs"] }),
      ),
    ).toThrow("normalized relative workspace path");
    expect(() =>
      validateProjectAuthoringAdapter(
        adapter({ generatedPaths: ["test/arbitrary.ts"] }),
      ),
    ).toThrow("normalized relative workspace path");
  });

  test("rejects emitted artifacts not declared by the adapter", () => {
    const validatedAdapter = validateProjectAuthoringAdapter(adapter());
    expect(() =>
      validateGeneratedArtifacts(validatedAdapter, [
        artifact("app/undeclared.ts"),
      ]),
    ).toThrow("is not declared");
  });

  test("accepts declared exact paths and allowlisted generated patterns", () => {
    const validatedAdapter = validateProjectAuthoringAdapter(
      adapter({
        generatedPathPatterns: [
          { prefix: "test/generated/", suffix: ".json" },
        ],
      }),
    );
    expect(
      validateGeneratedArtifacts(validatedAdapter, [
        artifact("app/game.ts"),
        artifact("test/generated/scenario.json"),
      ]),
    ).toHaveLength(2);
  });
});
