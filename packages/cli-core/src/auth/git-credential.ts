import type { UserTokenManager } from "../ports/user-token-manager.js";

export type GitCredentialRequest = {
  readonly protocol?: string;
  readonly host?: string;
  readonly path?: string;
};

export type GitCredentialPolicy = {
  readonly allowedHosts: readonly string[];
  readonly allowedPathPattern?: RegExp;
};

export type GitCredentialResponse = {
  readonly username: "x-dreamboard-token";
  readonly password: string;
};

const DEFAULT_REPOSITORY_PATH = /^repos\/[0-9a-fA-F-]{36}\.git$/;

export function parseGitCredentialRequest(input: string): GitCredentialRequest {
  const result: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return {
    protocol: result.protocol,
    host: result.host,
    path: result.path,
  };
}

export function formatGitCredentialResponse(
  response: GitCredentialResponse,
): string {
  return `username=${response.username}\npassword=${response.password}\n\n`;
}

export async function resolveGitCredential(input: {
  request: GitCredentialRequest;
  policy: GitCredentialPolicy;
  tokenManager: Pick<UserTokenManager, "resolveGitToken">;
}): Promise<GitCredentialResponse | null> {
  const protocol = input.request.protocol?.toLowerCase();
  const host = input.request.host?.toLowerCase();
  const path = normalizeCredentialPath(input.request.path);
  const allowedHosts = new Set(
    input.policy.allowedHosts.map((value) => value.toLowerCase()),
  );
  const pathPattern = input.policy.allowedPathPattern ?? DEFAULT_REPOSITORY_PATH;

  if (protocol !== "https" || !host || !allowedHosts.has(host)) {
    return null;
  }

  if (!path || !pathPattern.test(path)) {
    return null;
  }

  const token = await input.tokenManager.resolveGitToken();
  return {
    username: "x-dreamboard-token",
    password: token.token,
  };
}

function normalizeCredentialPath(value: string | undefined): string | null {
  if (!value) return null;
  return value.replace(/^\/+/, "");
}
