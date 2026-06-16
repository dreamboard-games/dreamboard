import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { Alias, ServerOptions } from "vite";
import { resolveDevDiagnosticsLevel } from "./dev-diagnostics.js";

export interface DevRuntimePlatformOptions {
  importMetaUrl: string;
  projectRoot: string;
  debug: boolean;
  port?: number;
  host?: string | boolean;
  allowedHosts?: string[];
  tailwindCssEntry: string;
}

export interface DevRuntimePlatform {
  devHostRoot: string;
  repoRoot: string;
  cliRoot: string;
  diagnosticsLevel: ReturnType<typeof resolveDevDiagnosticsLevel>;
  viteLogLevel: "info" | "warn";
  serverConfig: ServerOptions;
  resolveDedupe: string[];
  resolveAlias: Alias[];
  optimizeDepsExclude: string[];
}

export function createDevRuntimePlatform(
  options: DevRuntimePlatformOptions,
): DevRuntimePlatform {
  const devHostRoot = resolveDevHostRoot(options.importMetaUrl);
  const cliRoot = resolveCliRoot(options.importMetaUrl);
  const repoRoot = resolveRepoRoot(cliRoot);
  const require = createRequire(options.importMetaUrl);
  const diagnosticsLevel = resolveDevDiagnosticsLevel(options.debug);
  const sdkRoot = resolvePackageRoot(
    require,
    cliRoot,
    "@dreamboard-games/sdk",
    "@dreamboard-games/sdk",
    "node_modules/@dreamboard-games/sdk",
  );
  const apiClientClientGen = resolvePackageSubpath(
    require,
    cliRoot,
    "@dreamboard-games/api-client/client.gen",
    "@dreamboard-games/api-client/client.gen",
    "node_modules/@dreamboard-games/api-client/dist/client.gen.js",
  );
  const uiHostRuntimeRoot = resolveUiHostRuntimeRoot(require, cliRoot);

  return {
    devHostRoot,
    repoRoot,
    cliRoot,
    diagnosticsLevel,
    viteLogLevel: diagnosticsLevel === "verbose" ? "info" : "warn",
    serverConfig: {
      host: options.host ?? "localhost",
      allowedHosts: options.allowedHosts,
      port: options.port ?? 5352,
      strictPort: false,
      watch: {
        ignored: createProjectOnlyWatchIgnored(options.projectRoot),
      },
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      },
      fs: {
        allow: [options.projectRoot, repoRoot],
      },
    },
    resolveDedupe: ["react", "react-dom", "@dreamboard-games/sdk"],
    resolveAlias: [
      {
        find: /^react$/,
        replacement: resolveCliDependency(
          require,
          cliRoot,
          "react",
          "node_modules/react/index.js",
        ),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: resolveCliDependency(
          require,
          cliRoot,
          "react/jsx-runtime",
          "node_modules/react/jsx-runtime.js",
        ),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: resolveCliDependency(
          require,
          cliRoot,
          "react/jsx-dev-runtime",
          "node_modules/react/jsx-dev-runtime.js",
        ),
      },
      {
        find: /^react-dom$/,
        replacement: resolveCliDependency(
          require,
          cliRoot,
          "react-dom",
          "node_modules/react-dom/index.js",
        ),
      },
      {
        find: /^react-dom\/client$/,
        replacement: resolveCliDependency(
          require,
          cliRoot,
          "react-dom/client",
          "node_modules/react-dom/client.js",
        ),
      },
      {
        find: /^@dreamboard-games\/sdk\/ui$/,
        replacement: path.resolve(sdkRoot, "dist/ui.js"),
      },
      {
        find: /^@dreamboard-games\/sdk\/ui\/components$/,
        replacement: path.resolve(sdkRoot, "dist/ui/components.js"),
      },
      {
        find: /^@dreamboard-games\/sdk\/runtime$/,
        replacement: path.resolve(sdkRoot, "dist/runtime.js"),
      },
      {
        find: /^@dreamboard-games\/sdk\/runtime\/runtime-api$/,
        replacement: path.resolve(sdkRoot, "dist/runtime/runtime-api.js"),
      },
      {
        find: /^@dreamboard-games\/sdk\/runtime\/primitives$/,
        replacement: path.resolve(sdkRoot, "dist/runtime/primitives.js"),
      },
      {
        find: /^@dreamboard-games\/sdk\/runtime\/workspace-contract$/,
        replacement: path.resolve(
          sdkRoot,
          "dist/runtime/workspace-contract.js",
        ),
      },
      {
        find: /^@dreamboard-games\/ui-host-runtime\/components$/,
        replacement: path.resolve(uiHostRuntimeRoot, "src/components/index.ts"),
      },
      {
        find: /^@dreamboard-games\/ui-host-runtime\/runtime$/,
        replacement: path.resolve(uiHostRuntimeRoot, "src/runtime/index.ts"),
      },
      {
        find: /^@dreamboard\/manifest-contract$/,
        replacement: path.resolve(
          options.projectRoot,
          "shared/manifest-contract.ts",
        ),
      },
      {
        find: /^#dreamboard\/ui-contract$/,
        replacement: path.resolve(
          options.projectRoot,
          "shared/generated/ui-contract.ts",
        ),
      },
      {
        find: /^@dreamboard-games\/sdk\/ui\/plugin-styles\.css$/,
        replacement: resolveCliDependency(
          require,
          cliRoot,
          "@dreamboard-games/sdk/ui/plugin-styles.css",
          "node_modules/@dreamboard-games/sdk/dist/ui/plugin-styles.css",
        ),
      },
      {
        find: /^@dreamboard-games\/api-client\/client\.gen$/,
        replacement: apiClientClientGen,
      },
      {
        find: /^@shared\/(.*)$/,
        replacement: path.resolve(options.projectRoot, "shared/$1"),
      },
      {
        find: /^tailwindcss$/,
        replacement: options.tailwindCssEntry,
      },
    ],
    // Author SDKs are resolved from the project, not the CLI root. Let Vite
    // transform them fresh so its CLI-scoped dependency cache cannot pin an
    // older local snapshot after `dreamboard sync`.
    optimizeDepsExclude: [
      "@dreamboard-games/sdk",
      "@dreamboard-games/sdk/ui",
      "@dreamboard-games/sdk/runtime",
      "@dreamboard-games/sdk/runtime/primitives",
      "@dreamboard-games/sdk/runtime/workspace-contract",
      "@dreamboard-games/sdk/reducer",
      "@dreamboard-games/sdk/types",
    ],
  };
}

function createProjectOnlyWatchIgnored(
  projectRoot: string,
): (file: string) => boolean {
  const normalizedProjectRoot = path.resolve(projectRoot);

  return (file) => {
    const normalizedFile = path.resolve(file);
    const relativePath = path.relative(normalizedProjectRoot, normalizedFile);
    const isInsideProject =
      relativePath === "" ||
      (relativePath.length > 0 &&
        !relativePath.startsWith("..") &&
        !path.isAbsolute(relativePath));

    if (!isInsideProject) {
      return true;
    }

    const pathSegments = relativePath.split(path.sep);
    return (
      pathSegments.includes(".dreamboard") ||
      pathSegments.includes("node_modules")
    );
  };
}

function resolveUiHostRuntimeRoot(
  require: NodeJS.Require,
  cliRoot: string,
): string {
  try {
    return path.dirname(
      require.resolve("@dreamboard-games/ui-host-runtime/package.json"),
    );
  } catch {
    return path.resolve(cliRoot, "dist/runtime-packages/ui-host-runtime");
  }
}

function resolvePackageRoot(
  require: NodeJS.Require,
  cliRoot: string,
  specifier: string,
  publicSpecifier: string,
  fallbackRelativePath: string,
): string {
  try {
    return path.dirname(require.resolve(`${specifier}/package.json`));
  } catch {
    try {
      return path.dirname(require.resolve(`${publicSpecifier}/package.json`));
    } catch {
      return path.resolve(cliRoot, "..", "..", fallbackRelativePath);
    }
  }
}

function resolvePackageSubpath(
  require: NodeJS.Require,
  cliRoot: string,
  specifier: string,
  publicSpecifier: string,
  fallbackRelativePath: string,
): string {
  try {
    return require.resolve(specifier);
  } catch {
    try {
      return require.resolve(publicSpecifier);
    } catch {
      return path.resolve(cliRoot, fallbackRelativePath);
    }
  }
}

function resolveCliDependency(
  require: NodeJS.Require,
  cliRoot: string,
  specifier: string,
  fallbackRelativePath: string,
): string {
  try {
    return require.resolve(specifier);
  } catch {
    return path.resolve(cliRoot, fallbackRelativePath);
  }
}

function resolveDevHostRoot(importMetaUrl: string): string {
  const currentDir = path.dirname(fileURLToPath(importMetaUrl));
  const packagedDirCandidate = path.resolve(currentDir, "dev-host");
  if (existsSync(packagedDirCandidate)) return packagedDirCandidate;
  const sourceDirCandidate = path.resolve(currentDir, "../src/dev-host");
  return existsSync(sourceDirCandidate) ? sourceDirCandidate : currentDir;
}

function resolveCliRoot(importMetaUrl: string): string {
  let currentDir = path.dirname(fileURLToPath(importMetaUrl));

  while (true) {
    if (existsSync(path.join(currentDir, "package.json"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return path.resolve(resolveDevHostRoot(importMetaUrl), "../..");
    }
    currentDir = parentDir;
  }
}

function resolveRepoRoot(cliRoot: string): string {
  let currentDir = cliRoot;

  while (true) {
    if (existsSync(path.join(currentDir, "pnpm-workspace.yaml"))) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return cliRoot;
    }
    currentDir = parentDir;
  }
}
