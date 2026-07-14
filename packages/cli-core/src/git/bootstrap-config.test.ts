import { describe, expect, test } from "bun:test";
import { configureDreamboardGitRepository } from "./bootstrap-config.js";

describe("configureDreamboardGitRepository", () => {
  test("sets the narrow local Git credential and redirect policy", async () => {
    const calls: Array<[string, string]> = [];

    await configureDreamboardGitRepository({
      root: "/project",
      credentialHelper: "!dreamboard auth git-credential",
      git: {
        async setLocalConfig(_root, key, value) {
          calls.push([key, value]);
        },
      },
    });

    expect(calls).toEqual([
      ["credential.useHttpPath", "true"],
      ["credential.helper", ""],
      ["--add credential.helper", "!dreamboard auth git-credential"],
      ["http.followRedirects", "false"],
      ["core.hooksPath", ".dreamboard/hooks"],
    ]);
  });
});
