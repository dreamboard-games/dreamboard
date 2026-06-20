import {
  formatGitCredentialResponse,
  parseGitCredentialRequest,
  resolveGitCredential,
} from "@dreamboard-games/cli-core";
import { getStoredSession } from "../../config/credential-store.js";
import { loadGlobalConfig } from "../../config/global-config.js";
import { resolveConfig } from "../../config/resolve.js";
import { createUserSessionManager } from "../../auth/user-session-manager.js";

const DEFAULT_ALLOWED_GIT_HOSTS = [
  "git.staging.dreamboard.games",
  "git.dreamboard.games",
];

export async function runGitCredentialHelper(
  input: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  const stdin = input.stdin ?? process.stdin;
  const stdout = input.stdout ?? process.stdout;
  const env = input.env ?? process.env;
  const request = parseGitCredentialRequest(await readAll(stdin));
  const response = await resolveGitCredential({
    request,
    policy: {
      allowedHosts: resolveAllowedGitHosts(env),
    },
    tokenManager: createUserSessionManager(
      resolveConfig(
        await loadGlobalConfig(),
        {},
        undefined,
        await getStoredSession(),
      ),
    ),
  });

  if (!response) {
    return;
  }

  stdout.write(formatGitCredentialResponse(response));
}

function resolveAllowedGitHosts(env: NodeJS.ProcessEnv): readonly string[] {
  const configured = env.DREAMBOARD_GIT_ALLOWED_HOSTS?.split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  return configured && configured.length > 0
    ? configured
    : DEFAULT_ALLOWED_GIT_HOSTS;
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  let data = "";
  stream.setEncoding("utf8");
  for await (const chunk of stream) {
    data += chunk;
  }
  return data;
}
