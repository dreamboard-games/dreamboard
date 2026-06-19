import { describe, expect, test } from "bun:test";
import {
  formatGitCredentialResponse,
  parseGitCredentialRequest,
  resolveGitCredential,
} from "./git-credential.js";

describe("git credential helper core", () => {
  test("parses and formats the Git credential protocol", () => {
    const request = parseGitCredentialRequest(
      "protocol=https\nhost=git.staging.dreamboard.games\npath=repos/019ede02-6ad3-7365-a71a-d9ee16bc639b.git\n\n",
    );

    expect(request).toEqual({
      protocol: "https",
      host: "git.staging.dreamboard.games",
      path: "repos/019ede02-6ad3-7365-a71a-d9ee16bc639b.git",
    });
    expect(
      formatGitCredentialResponse({
        username: "x-dreamboard-token",
        password: "git.jwt",
      }),
    ).toBe("username=x-dreamboard-token\npassword=git.jwt\n\n");
  });

  test("mints a token only for allowed HTTPS Dreamboard repository paths", async () => {
    let mintCount = 0;
    const tokenManager = {
      async resolveGitToken() {
        mintCount += 1;
        return { token: "git.jwt", audience: "dreamboard-git" as const };
      },
    };

    await expect(
      resolveGitCredential({
        request: {
          protocol: "https",
          host: "git.staging.dreamboard.games",
          path: "repos/019ede02-6ad3-7365-a71a-d9ee16bc639b.git",
        },
        policy: { allowedHosts: ["git.staging.dreamboard.games"] },
        tokenManager,
      }),
    ).resolves.toEqual({
      username: "x-dreamboard-token",
      password: "git.jwt",
    });

    await expect(
      resolveGitCredential({
        request: {
          protocol: "https",
          host: "git.staging.dreamboard.games",
          path: "other/repo.git",
        },
        policy: { allowedHosts: ["git.staging.dreamboard.games"] },
        tokenManager,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveGitCredential({
        request: {
          protocol: "http",
          host: "git.staging.dreamboard.games",
          path: "repos/019ede02-6ad3-7365-a71a-d9ee16bc639b.git",
        },
        policy: { allowedHosts: ["git.staging.dreamboard.games"] },
        tokenManager,
      }),
    ).resolves.toBeNull();
    await expect(
      resolveGitCredential({
        request: {
          protocol: "https",
          host: "forgejo.example.com",
          path: "repos/019ede02-6ad3-7365-a71a-d9ee16bc639b.git",
        },
        policy: { allowedHosts: ["git.staging.dreamboard.games"] },
        tokenManager,
      }),
    ).resolves.toBeNull();
    expect(mintCount).toBe(1);
  });
});
