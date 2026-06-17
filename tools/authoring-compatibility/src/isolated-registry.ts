import { createServer, type Server } from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createReadStream } from "node:fs";
import type { CandidatePackage, CandidateSet } from "./candidate.ts";

export type IsolatedRegistry = {
  url: string;
  stop(): Promise<void>;
  receipt: {
    packageNames: string[];
    versions: Record<string, string>;
    requestLog: string[];
  };
};

export async function startIsolatedRegistry(
  candidateSet: CandidateSet,
): Promise<IsolatedRegistry> {
  const packagesByName = new Map<string, CandidatePackage>();
  const tarballsByName = new Map<string, CandidatePackage>();
  for (const candidate of Object.values(candidateSet.packages)) {
    packagesByName.set(candidate.packageJson.name, candidate);
    tarballsByName.set(candidate.tarballName, candidate);
  }

  const requestLog: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const decodedPath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    requestLog.push(`${request.method ?? "GET"} ${url.pathname}`);

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405);
      response.end();
      return;
    }

    const packageCandidate = packagesByName.get(decodedPath);
    if (packageCandidate) {
      const body = JSON.stringify(
        packageMetadata(packageCandidate, registryUrl()),
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }

    const tarballName = path.basename(decodedPath);
    const tarballCandidate = tarballsByName.get(tarballName);
    if (tarballCandidate) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      if (request.method === "HEAD") {
        response.end();
      } else {
        createReadStream(tarballCandidate.tarballPath).pipe(response);
      }
      return;
    }

    if (decodedPath.startsWith("@dreamboard-games/")) {
      await proxyPublicPackage(url, response);
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "registry only serves candidates" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  function registryUrl() {
    const address = server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  return {
    url: registryUrl(),
    stop: () => stopServer(server),
    receipt: {
      packageNames: [...packagesByName.keys()].sort(),
      versions: Object.fromEntries(
        [...packagesByName.values()]
          .map((candidate) => [
            candidate.packageJson.name,
            candidate.packageJson.version,
          ])
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
      requestLog,
    },
  };
}

async function proxyPublicPackage(
  url: URL,
  response: import("node:http").ServerResponse,
) {
  const upstream = `https://registry.npmjs.org${url.pathname}${url.search}`;
  try {
    const upstreamResponse = await fetch(upstream, {
      headers: { accept: "application/json" },
    });
    response.writeHead(upstreamResponse.status, {
      "content-type":
        upstreamResponse.headers.get("content-type") ?? "application/json",
    });
    response.end(await upstreamResponse.text());
  } catch (error) {
    response.writeHead(502, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        error: "failed to fetch non-candidate public package",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function packageMetadata(candidate: CandidatePackage, registryUrl: string) {
  const manifest = {
    ...candidate.packageJson,
    dist: {
      tarball: `${registryUrl}/${encodeURIComponent(candidate.packageJson.name)}/-/${candidate.tarballName}`,
      integrity: candidate.integrity,
      shasum: candidate.sha512Hex.slice(0, 40),
    },
  };
  return {
    name: candidate.packageJson.name,
    "dist-tags": {
      latest: candidate.packageJson.version,
    },
    versions: {
      [candidate.packageJson.version]: manifest,
    },
  };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
