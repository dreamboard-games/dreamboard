import path from "node:path";
import { readdir } from "node:fs/promises";
import { expect, test } from "bun:test";
import { SCAFFOLD_OWNERSHIP } from "./scaffold-ownership.generated.js";
import {
  isCliStaticPath,
  isDynamicGeneratedPath,
  isDynamicSeedPath,
  isLibraryPath,
  normalizeOwnedProjectPath,
} from "./scaffold-ownership.js";
import { resolveStaticAssetRoot } from "./static-scaffold.js";

async function getStaticScaffoldTargetPaths(): Promise<string[]> {
  const root = resolveStaticAssetRoot();
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(path.relative(root, fullPath).replace(/\\/g, "/"));
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

test("generated ownership file exposes the current scaffold contract", () => {
  expect(SCAFFOLD_OWNERSHIP.version).toBeGreaterThan(2);
  expect(SCAFFOLD_OWNERSHIP.allowedPaths.rootFiles).toContain("manifest.ts");
  expect(SCAFFOLD_OWNERSHIP.cliStatic.exactFiles).toContain("ui/index.tsx");
  expect(SCAFFOLD_OWNERSHIP.dynamic.generatedFiles).toContain(
    "shared/generated/ui-contract.ts",
  );
});

test("all bundled static scaffold files are framework-owned", async () => {
  for (const targetPath of await getStaticScaffoldTargetPaths()) {
    expect(isLibraryPath(targetPath)).toBe(true);
    expect(isDynamicSeedPath(targetPath)).toBe(false);
  }
});

test("dynamic generated and seed paths are not classified as cli-static", () => {
  for (const dynamicPath of SCAFFOLD_OWNERSHIP.dynamic.generatedFiles) {
    expect(isCliStaticPath(dynamicPath)).toBe(false);
    expect(isDynamicGeneratedPath(dynamicPath)).toBe(true);
  }

  for (const seedPath of SCAFFOLD_OWNERSHIP.dynamic.seedFiles) {
    expect(isCliStaticPath(seedPath)).toBe(false);
    expect(isDynamicSeedPath(seedPath)).toBe(true);
  }

  const seedPatternSample = "app/phases/setup.ts";
  expect(isDynamicSeedPath(seedPatternSample)).toBe(true);
  expect(isCliStaticPath(seedPatternSample)).toBe(false);
});

test("strict ownership path normalization rejects unsafe forms", () => {
  const unsafePaths = [
    "",
    "   ",
    "../escape.ts",
    "app/../escape.ts",
    "/app/game.ts",
    "app//game.ts",
    "./app/game.ts",
    "app/./game.ts",
    "app\\game.ts",
    "C:\\temp\\game.ts",
    "C:/temp/game.ts",
    "\\\\server\\share\\game.ts",
    "//server/share/game.ts",
    "\\\\?\\C:\\temp\\game.ts",
    "https://example.com/game.ts",
    "file:///tmp/game.ts",
    "app/%2f/game.ts",
    "app/%5C/game.ts",
    "app/\u0000game.ts",
    "app/\u001fgame.ts",
    "app/CON",
    "app/nul.txt",
    "app/LPT1",
  ];

  for (const unsafePath of unsafePaths) {
    expect(normalizeOwnedProjectPath(unsafePath)).toBeNull();
    expect(isDynamicSeedPath(unsafePath)).toBe(false);
    expect(isCliStaticPath(unsafePath)).toBe(false);
    expect(isLibraryPath(unsafePath)).toBe(false);
  }
});

test("strict ownership path normalization preserves allowed relative paths", () => {
  expect(normalizeOwnedProjectPath("app/phases/setup.ts")).toBe(
    "app/phases/setup.ts",
  );
  expect(normalizeOwnedProjectPath("ui/components/Panel.tsx")).toBe(
    "ui/components/Panel.tsx",
  );
  expect(isDynamicSeedPath("app/phases/setup.ts")).toBe(true);
});

test("ownership exact cli-static asset files are bundled in the scaffold", async () => {
  const bundledPaths = new Set(await getStaticScaffoldTargetPaths());

  for (const filePath of SCAFFOLD_OWNERSHIP.cliStatic.exactFiles) {
    if (filePath === ".npmrc" || filePath === "package.json") continue;
    if (filePath === "ui/package.json") continue;
    expect(bundledPaths.has(filePath)).toBe(true);
  }
});

test("ownership cli-static directory prefixes are represented in the scaffold", async () => {
  const bundledPaths = await getStaticScaffoldTargetPaths();

  for (const prefix of SCAFFOLD_OWNERSHIP.cliStatic.directoryPrefixes) {
    expect(bundledPaths.some((filePath) => filePath.startsWith(prefix))).toBe(
      true,
    );
  }
});
