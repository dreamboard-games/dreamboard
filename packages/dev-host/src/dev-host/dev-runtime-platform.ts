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
  packageRoot: string;
  sdkRoot: string;
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
  const packageRoot = resolveCurrentPackageRoot(options.importMetaUrl);
  const packageRequire = createRequire(options.importMetaUrl);
  const projectRequire = createRequire(
    path.join(options.projectRoot, "package.json"),
  );
  const diagnosticsLevel = resolveDevDiagnosticsLevel(options.debug);
  const sdkRoot = resolveInstalledPackageRoot(
    projectRequire,
    packageRoot,
    "@dreamboard-games/sdk",
  );
  const apiClientClientGen = resolvePackageSubpath(
    packageRequire,
    packageRoot,
    "@dreamboard-games/api-client/client.gen",
    "node_modules/@dreamboard-games/api-client/dist/client.gen.js",
  );
  const uiHostRuntimeRoot = resolveUiHostRuntimeRoot(
    packageRequire,
    packageRoot,
  );

  return {
    devHostRoot,
    packageRoot,
    sdkRoot,
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
        allow: [options.projectRoot, packageRoot, sdkRoot, uiHostRuntimeRoot],
      },
    },
    resolveDedupe: ["react", "react-dom", "@dreamboard-games/sdk"],
    resolveAlias: [
      {
        find: /^react$/,
        replacement: resolveCliDependency(
          packageRequire,
          packageRoot,
          "react",
          "node_modules/react/index.js",
        ),
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: resolveCliDependency(
          packageRequire,
          packageRoot,
          "react/jsx-runtime",
          "node_modules/react/jsx-runtime.js",
        ),
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: resolveCliDependency(
          packageRequire,
          packageRoot,
          "react/jsx-dev-runtime",
          "node_modules/react/jsx-dev-runtime.js",
        ),
      },
      {
        find: /^react-dom$/,
        replacement: resolveCliDependency(
          packageRequire,
          packageRoot,
          "react-dom",
          "node_modules/react-dom/index.js",
        ),
      },
      {
        find: /^react-dom\/client$/,
        replacement: resolveCliDependency(
          packageRequire,
          packageRoot,
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
          projectRequire,
          sdkRoot,
          "@dreamboard-games/sdk/ui/plugin-styles.css",
          "dist/ui/plugin-styles.css",
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
  packageRoot: string,
): string {
  try {
    return path.dirname(
      require.resolve("@dreamboard-games/ui-host-runtime/package.json"),
    );
  } catch {
    return path.resolve(packageRoot, "dist/runtime-packages/ui-host-runtime");
  }
}

function resolveInstalledPackageRoot(
  require: NodeJS.Require,
  fallbackRoot: string,
  specifier: string,
): string {
  try {
    return path.dirname(require.resolve(`${specifier}/package.json`));
  } catch {
    return path.resolve(fallbackRoot, "node_modules", specifier);
  }
}

function resolvePackageSubpath(
  require: NodeJS.Require,
  packageRoot: string,
  specifier: string,
  fallbackRelativePath: string,
): string {
  try {
    return require.resolve(specifier);
  } catch {
    return path.resolve(packageRoot, fallbackRelativePath);
  }
}

function resolveCliDependency(
  require: NodeJS.Require,
  packageRoot: string,
  specifier: string,
  fallbackRelativePath: string,
): string {
  try {
    return require.resolve(specifier);
  } catch {
    return path.resolve(packageRoot, fallbackRelativePath);
  }
}

function resolveDevHostRoot(importMetaUrl: string): string {
  const currentDir = path.dirname(fileURLToPath(importMetaUrl));
  const sourceDirCandidate = path.resolve(
    resolveCurrentPackageRoot(importMetaUrl),
    "src/dev-host",
  );
  return existsSync(sourceDirCandidate) ? sourceDirCandidate : currentDir;
}

function resolveCurrentPackageRoot(importMetaUrl: string): string {
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
