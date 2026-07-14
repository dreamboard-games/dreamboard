import { describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { runGitCredentialHelper } from "./git-credential-helper.js";

describe("runGitCredentialHelper", () => {
  test("prints nothing for untrusted hosts", async () => {
    let output = "";
    await runGitCredentialHelper({
      stdin: Readable.from(
        "protocol=https\nhost=forgejo.example.com\npath=repos/019ede02-6ad3-7365-a71a-d9ee16bc639b.git\n\n",
      ),
      stdout: new Writable({
        write(chunk, _encoding, callback) {
          output += chunk.toString();
          callback();
        },
      }),
      env: {
        DREAMBOARD_GIT_ALLOWED_HOSTS: "git.staging.dreamboard.games",
      },
    });

    expect(output).toBe("");
  });
});
