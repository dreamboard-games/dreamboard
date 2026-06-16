import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import react from "@vitejs/plugin-react";
import tailwindcssPostcss from "@tailwindcss/postcss";
import { createServer, type ViteDevServer } from "vite";
import type { ResolvedConfig } from "../types.js";
import { createDevApiProxyPlugin } from "./dev-api-proxy-plugin.js";
import { createDevRuntimePlatform } from "./dev-runtime-platform.js";
import { createVirtualDevModulesPlugin } from "./dev-virtual-modules-plugin.js";
import { createDevLogRelayPlugin } from "./dev-log-relay-plugin.js";
import { prepareFallbackStylesheet } from "./dev-fallback-stylesheet.js";
import { createDevHmrGuardPlugin } from "./dev-hmr-guard-plugin.js";
import type { DreamboardDevRuntimeConfig } from "./dev-runtime-config.js";

const require = createRequire(import.meta.url);
const tailwindCssEntry = require.resolve("tailwindcss/index.css");

export type { DreamboardDevRuntimeConfig } from "./dev-runtime-config.js";

export async function startDreamboardDevServer(options: {
  projectRoot: string;
  sessionFilePath: string;
  port?: number;
  host?: string | boolean;
  allowedHosts?: string[];
  runtimeConfig: DreamboardDevRuntimeConfig;
  config: ResolvedConfig;
}): Promise<{
  url: string;
  networkUrls: string[];
  close: () => Promise<void>;
  server: ViteDevServer;
}> {
  const { projectRoot, port, host, allowedHosts, runtimeConfig, config } =
    options;
  const platform = createDevRuntimePlatform({
    importMetaUrl: import.meta.url,
    projectRoot,
    debug: runtimeConfig.debug,
    port,
    host,
    allowedHosts,
    tailwindCssEntry,
  });
  const generatedFallbackStylesheetPath = prepareFallbackStylesheet({
    projectRoot,
    repoRoot: platform.repoRoot,
  });

  const server = await createServer({
    root: platform.devHostRoot,
    appType: "spa",
    plugins: [
      createDevHmrGuardPlugin({ projectRoot }),
      react(),
      createVirtualDevModulesPlugin({
        projectRoot,
        runtimeConfig,
        generatedFallbackStylesheetPath,
      }),
      createDevApiProxyPlugin({ config }),
      createDevLogRelayPlugin({
        sessionFilePath: options.sessionFilePath,
        runtimeConfig,
        config,
        diagnosticsLevel: platform.diagnosticsLevel,
      }),
    ],
    css: {
      postcss: {
        plugins: [tailwindcssPostcss()],
      },
    },
    logLevel: platform.viteLogLevel,
    resolve: {
      dedupe: platform.resolveDedupe,
      alias: platform.resolveAlias,
    },
    optimizeDeps: {
      exclude: platform.optimizeDepsExclude,
    },
    server: platform.serverConfig,
  });

  await server.listen();
  const resolvedPort = getBoundPort(server);
  const url = `http://localhost:${resolvedPort}/index.html`;
  return {
    url,
    networkUrls: getNetworkUrls(host, resolvedPort),
    close: async () => {
      await server.close();
      if (generatedFallbackStylesheetPath) {
        rmSync(generatedFallbackStylesheetPath, { force: true });
      }
    },
    server,
  };
}

function getNetworkUrls(
  host: string | boolean | undefined,
  port: number,
): string[] {
  if (!host) return [];
  if (typeof host === "string" && isLoopbackHost(host)) return [];

  const hosts =
    host === true || host === "0.0.0.0" || host === "::"
      ? getLanIpv4Addresses()
      : [host];

  return hosts.map(
    (value) => `http://${formatUrlHost(value)}:${port}/index.html`,
  );
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function getLanIpv4Addresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((details) => details.family === "IPv4" && !details.internal)
    .map((details) => details.address);
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function getBoundPort(server: ViteDevServer): number {
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine local dev server port.");
  }
  return address.port;
}
