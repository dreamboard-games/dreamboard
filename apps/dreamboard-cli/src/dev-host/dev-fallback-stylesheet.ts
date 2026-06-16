import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { normalizePath } from "vite";

export function prepareFallbackStylesheet(options: {
  projectRoot: string;
  repoRoot: string;
}): string | null {
  const projectStylePath = path.resolve(options.projectRoot, "ui/style.css");
  if (existsSync(projectStylePath)) {
    return null;
  }

  const generatedDir = path.resolve(options.repoRoot, ".dreamboard-dev");
  mkdirSync(generatedDir, { recursive: true });

  const fingerprint = createHash("sha256")
    .update(options.projectRoot, "utf8")
    .digest("hex")
    .slice(0, 8);
  const instanceId = randomUUID().replaceAll("-", "").slice(0, 8);
  const generatedPath = path.join(
    generatedDir,
    `plugin-styles-${fingerprint}-${instanceId}.css`,
  );
  const sharedStylesPath = normalizePath(
    path.resolve(
      options.repoRoot,
      "node_modules/@dreamboard-games/sdk/dist/ui/plugin-styles.css",
    ),
  );
  const uiSourcePath = normalizePath(
    path.resolve(options.projectRoot, "ui/**/*.{ts,tsx}"),
  );
  const sharedSourcePath = normalizePath(
    path.resolve(options.projectRoot, "shared/**/*.{ts,tsx}"),
  );

  writeFileSync(
    generatedPath,
    [
      `@import "/@fs/${sharedStylesPath}";`,
      "",
      `@source "${uiSourcePath}";`,
      `@source "${sharedSourcePath}";`,
      "",
    ].join("\n"),
    "utf8",
  );

  return generatedPath;
}
