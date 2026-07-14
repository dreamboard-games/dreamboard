import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";

type CliAuthPayload = {
  token?: string;
  refreshToken?: string;
  state?: string;
};

type CliAuthResult = {
  token: string;
  refreshToken: string | null;
};

type OAuthCodeResult = {
  code: string;
};

const DEFAULT_OAUTH_CALLBACK_PORT = 49371;

export async function startCliAuthServer(
  state: string,
  timeoutMs: number,
): Promise<{
  port: number;
  waitForToken: Promise<CliAuthResult>;
  close: () => void;
}> {
  let resolveToken: (token: CliAuthResult) => void;
  let rejectToken: (error: Error) => void;

  const waitForToken = new Promise<CliAuthResult>((resolve, reject) => {
    resolveToken = resolve;
    rejectToken = reject;
  });

  let server: ReturnType<typeof createServer> | null = null;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < 10; attempt++) {
    const portCandidate = 49152 + Math.floor(Math.random() * 16383);
    try {
      server = createServer(
        async (request: IncomingMessage, response: ServerResponse) => {
          try {
            await handleAuthRequest(
              request,
              response,
              state,
              resolveToken!,
              () => server?.close(),
            );
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Failed to handle auth callback.";
            writeCorsResponse(request, response, 500, message);
          }
        },
      );
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(portCandidate, "127.0.0.1", () => {
          server!.off("error", reject);
          resolve();
        });
      });
      break;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("Failed to start auth server");
    }
  }

  if (!server) {
    const error =
      lastError ?? new Error("Failed to start auth callback server.");
    rejectToken!(error);
    throw error;
  }

  const timer = setTimeout(() => {
    rejectToken!(new Error("Login timed out."));
    server?.close();
  }, timeoutMs);

  waitForToken.finally(() => clearTimeout(timer));

  return {
    port: portCandidateFromServer(server),
    waitForToken,
    close: () => server?.close(),
  };
}

export async function startOAuthCallbackServer(
  state: string,
  timeoutMs: number,
): Promise<{
  port: number;
  redirectUri: string;
  waitForCode: Promise<OAuthCodeResult>;
  close: () => void;
}> {
  let resolveCode: (result: OAuthCodeResult) => void;
  let rejectCode: (error: Error) => void;

  const waitForCode = new Promise<OAuthCodeResult>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const portCandidate = resolveOAuthCallbackPort();
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      try {
        const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
        if (
          request.method === "GET" &&
          requestUrl.pathname === "/oauth/callback"
        ) {
          const receivedState = requestUrl.searchParams.get("state");
          const code = requestUrl.searchParams.get("code");
          const error = requestUrl.searchParams.get("error");
          if (error) {
            throw new Error(`Clerk OAuth returned ${error}.`);
          }
          if (!code || receivedState !== state) {
            writeCorsResponse(request, response, 400, "Invalid OAuth callback");
            return;
          }
          resolveCode!({ code });
          response.once("finish", () => server.close());
          writeHtmlResponse(
            response,
            200,
            "Dreamboard CLI login complete. You can return to your terminal.",
          );
          return;
        }
        writeHtmlResponse(
          response,
          200,
          "Dreamboard CLI OAuth callback server",
        );
      } catch (error) {
        rejectCode!(
          error instanceof Error
            ? error
            : new Error("Failed to handle OAuth callback."),
        );
        writeHtmlResponse(response, 500, "Dreamboard CLI login failed.");
      }
    },
  );

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(portCandidate, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    const portError =
      error instanceof Error
        ? error
        : new Error("Failed to start OAuth callback server");
    const configuredByEnv = Boolean(
      process.env.DREAMBOARD_CLERK_OAUTH_REDIRECT_PORT,
    );
    const message = configuredByEnv
      ? `Failed to start OAuth callback server on configured port ${portCandidate}.`
      : `Failed to start OAuth callback server on port ${portCandidate}. Register this loopback redirect URI with Clerk and keep the port available, or set DREAMBOARD_CLERK_OAUTH_REDIRECT_PORT.`;
    const wrapped = new Error(`${message} ${portError.message}`);
    server.close();
    rejectCode!(wrapped);
    throw wrapped;
  }

  if (!server.listening) {
    const error = new Error("Failed to start OAuth callback server.");
    rejectCode!(error);
    throw error;
  }

  const timer = setTimeout(() => {
    rejectCode!(new Error("Login timed out."));
    server?.close();
  }, timeoutMs);

  waitForCode.finally(() => clearTimeout(timer));
  const port = portCandidateFromServer(server);

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}/oauth/callback`,
    waitForCode,
    close: () => server?.close(),
  };
}

function resolveOAuthCallbackPort(): number {
  const rawPort = process.env.DREAMBOARD_CLERK_OAUTH_REDIRECT_PORT?.trim();
  if (!rawPort) {
    return DEFAULT_OAUTH_CALLBACK_PORT;
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid DREAMBOARD_CLERK_OAUTH_REDIRECT_PORT '${rawPort}'. Expected a TCP port from 1 to 65535.`,
    );
  }
  return port;
}

function portCandidateFromServer(
  server: ReturnType<typeof createServer>,
): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Auth callback server did not expose a bound port.");
  }
  return address.port;
}

async function handleAuthRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: string,
  resolveToken: (token: CliAuthResult) => void,
  closeServer: () => void,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "OPTIONS") {
    writeCorsResponse(request, response, 204, "");
    return;
  }

  if (requestUrl.pathname === "/cli-auth" && request.method === "POST") {
    const text = await readRequestBody(request);
    let payload: CliAuthPayload | null = null;
    try {
      payload = JSON.parse(text) as CliAuthPayload;
    } catch {
      payload = null;
    }

    const token = payload?.token;
    const refreshToken = payload?.refreshToken;
    const receivedState = payload?.state;
    if (!token || receivedState !== state) {
      writeCorsResponse(request, response, 400, "Invalid auth payload");
      return;
    }

    resolveToken({ token, refreshToken: refreshToken ?? null });
    response.once("finish", () => {
      closeServer();
    });
    writeCorsResponse(request, response, 200, "OK");
    return;
  }

  writeCorsResponse(request, response, 200, "Dreamboard CLI auth server");
}

function writeCorsResponse(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  const origin = request.headers.origin ?? "*";
  response.writeHead(statusCode, {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "text/plain; charset=utf-8",
  });
  response.end(body);
}

function writeHtmlResponse(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
  });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>Dreamboard CLI</title><p>${escapeHtml(body)}</p>`,
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function openBrowser(url: string): void {
  const platform = process.platform;
  let command: [string, ...string[]];
  if (platform === "darwin") {
    command = ["open", url];
  } else if (platform === "win32") {
    command = ["cmd", "/c", "start", "", url];
  } else {
    command = ["xdg-open", url];
  }
  const [commandName, ...commandArgs] = command;
  const child = spawn(commandName, commandArgs, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}
