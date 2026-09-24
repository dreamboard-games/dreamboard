import type { RuntimeJson } from "@dreamboard-games/sdk";
import { createServer } from "node:http";
import { build } from "esbuild";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
export interface DevHostOptions {
  projectRoot: string;
  port?: number;
  players?: number;
  seed?: number;
  options?: Record<string, RuntimeJson>;
}
const assets = {
  ".png": "dataurl",
  ".jpg": "dataurl",
  ".jpeg": "dataurl",
  ".gif": "dataurl",
  ".svg": "dataurl",
  ".webp": "dataurl",
  ".woff": "dataurl",
  ".woff2": "dataurl",
} as const;
export async function buildProject(projectRoot: string) {
  const common = {
    absWorkingDir: projectRoot,
    bundle: true,
    write: false,
    platform: "browser" as const,
    target: "es2022",
    loader: assets,
    define: { "process.env.NODE_ENV": '"development"' },
  };
  const reducer = await build({
    ...common,
    format: "esm",
    stdin: {
      resolveDir: projectRoot,
      contents: `
import bundle from './app/index.ts';
import manifest from './manifest.ts';
import { compileManifest } from '@dreamboard-games/sdk/reducer';
const compiled = compileManifest(manifest);
export default {...bundle,initialize(input){return bundle.initialize({...input,table:compiled.createInitialTable({playerIds:input.playerIds})})}};
`,
    },
  });
  const ui = await build({
    ...common,
    plugins: [
      {
        name: "project-tailwind",
        setup(builder) {
          builder.onLoad({ filter: /\.css$/ }, async (args) => {
            const result = await postcss([
              tailwindcss({ base: projectRoot }),
            ]).process(await readFile(args.path, "utf8"), { from: args.path });
            return {
              contents: result.css,
              loader: "css",
              resolveDir: path.dirname(args.path),
            };
          });
        },
      },
    ],
    format: "iife",
    outfile: "plugin.js",
    jsx: "automatic",
    stdin: {
      resolveDir: projectRoot,
      loader: "tsx",
      contents: `
import './ui/index.tsx';
`,
    },
  });
  const js = ui.outputFiles!.find((file) => file.path.endsWith(".js"))!.text;
  const css =
    ui.outputFiles!.find((file) => file.path.endsWith(".css"))?.text ?? "";
  const uiHtml = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>${css.replaceAll("</style", "<\\/style")}</style><div id="root"></div><script>${js.replaceAll("</script", "<\\/script")}</script>`;
  const reducerSource = reducer.outputFiles![0]!.text;
  return {
    reducerSource,
    uiHtml,
    revision: createHash("sha256")
      .update(reducerSource)
      .update(uiHtml)
      .digest("hex"),
  };
}
export async function startDevHost(options: DevHostOptions) {
  const projectRoot = path.resolve(options.projectRoot);
  const players = options.players ?? 2;
  if (!Number.isSafeInteger(options.seed ?? 1))
    throw new Error("seed must be a safe integer");
  if (!Number.isInteger(players) || players < 1 || players > 64)
    throw new Error("players must be an integer from 1 to 64");
  const hostScript = await readFile(
    new URL("./host.js", import.meta.url),
    "utf8",
  );
  const server = createServer(async (req, res) => {
    try {
      const address = server.address();
      if (
        !address ||
        typeof address === "string" ||
        req.headers.host !== `127.0.0.1:${address.port}`
      ) {
        res.writeHead(403).end();
        return;
      }
      if (req.method !== "GET") {
        res.writeHead(405).end();
        return;
      }
      if (req.url === "/host.js") {
        res
          .writeHead(200, { "Content-Type": "text/javascript" })
          .end(hostScript);
        return;
      }
      if (req.url === "/project.json") {
        const project = await buildProject(projectRoot);
        res
          .writeHead(200, {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          })
          .end(
            JSON.stringify({
              ...project,
              playerIds: Array.from(
                { length: players },
                (_, i) => `player-${i + 1}`,
              ),
              seed: options.seed ?? 1,
              options: options.options ?? {},
            }),
          );
        return;
      }
      if (req.url !== "/") {
        res.writeHead(404).end();
        return;
      }
      res
        .writeHead(200, {
          "Content-Type": "text/html",
          "Cache-Control": "no-store",
        })
        .end(
          `<!doctype html><meta name="viewport" content="width=device-width"><title>Dreamboard local play</title><style>*{box-sizing:border-box}body{margin:0;height:100dvh;display:flex;flex-direction:column;font:16px system-ui;background:#faf8f2;color:#282621}header{padding:12px;display:flex;flex-wrap:wrap;gap:12px;align-items:center}button,select{font:inherit;padding:6px;max-width:100%}iframe{width:100%;flex:1;min-height:0;border:0}#error{color:#b42318;white-space:pre-wrap;padding:12px;max-height:30vh;overflow:auto}#error:empty{display:none}</style><header><strong>Local play</strong><select id="seat" aria-label="Playing as"></select><button id="reset">Reset game</button><button id="checkpoint">Save checkpoint</button><button id="restore" disabled>Restore checkpoint</button><span id="status">Loading…</span></header><div id="error" role="alert"></div><script type="module" src="/host.js"></script>`,
        );
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 5173, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : options.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
