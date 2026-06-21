import { expect, test } from "bun:test";
import {
  assertExactCommitSourcePolicy,
  parseGitTree,
  runExactCommitVerification,
  type GitTreeEntry,
} from "./exact-commit-verifier.js";

function blob(path: string): GitTreeEntry {
  return {
    mode: "100644",
    type: "blob",
    objectId: "abc123",
    path,
  };
}

async function expectPolicyRejects(
  entries: GitTreeEntry[],
  contents: Record<string, string> = {},
): Promise<string> {
  try {
    await assertExactCommitSourcePolicy({
      worktreeRoot: "/tmp/worktree",
      entries,
      readFile: async (_root, relativePath) =>
        Buffer.from(contents[relativePath] ?? "", "utf8"),
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected policy rejection");
}

test("parseGitTree decodes nul-delimited git tree output", () => {
  expect(
    parseGitTree(
      "100644 blob abc123\t.dreamboard/project.json\0" +
        "100755 blob def456\tscripts/run.sh\0",
    ),
  ).toEqual([
    {
      mode: "100644",
      type: "blob",
      objectId: "abc123",
      path: ".dreamboard/project.json",
    },
    {
      mode: "100755",
      type: "blob",
      objectId: "def456",
      path: "scripts/run.sh",
    },
  ]);
});

test("exact commit source policy accepts authored source and project manifest", async () => {
  await expect(
    assertExactCommitSourcePolicy({
      worktreeRoot: "/tmp/worktree",
      entries: [
        blob(".dreamboard/project.json"),
        blob("app/game.ts"),
        blob("test/scenarios/first-turn.scenario.ts"),
      ],
      readFile: async () => Buffer.from("export {}\n", "utf8"),
    }),
  ).resolves.toBeUndefined();
});

test("exact commit source policy rejects gitlinks and .gitmodules", async () => {
  const message = await expectPolicyRejects([
    {
      mode: "160000",
      type: "commit",
      objectId: "abc123",
      path: "vendor/game-lib",
    },
    blob(".gitmodules"),
  ]);

  expect(message).toContain("gitlinks/submodules are not allowed");
  expect(message).toContain(".gitmodules is not allowed");
});

test("exact commit source policy rejects lfs configuration and pointers", async () => {
  const message = await expectPolicyRejects(
    [blob(".gitattributes"), blob("assets/card.png")],
    {
      ".gitattributes": "*.png filter=lfs diff=lfs merge=lfs -text\n",
      "assets/card.png":
        "version https://git-lfs.github.com/spec/v1\noid sha256:abc\n",
    },
  );

  expect(message).toContain(".gitattributes configures Git LFS");
  expect(message).toContain("Git LFS pointer files are not allowed");
});

test("exact commit source policy rejects generated and credential-like files", async () => {
  const message = await expectPolicyRejects([
    blob("test/generated/scenario-manifest.generated.ts"),
    blob(".dreamboard/state.json"),
    blob(".env.local"),
    blob("keys/private.pem"),
    blob(".npmrc"),
  ], {
    ".npmrc": "//registry.npmjs.org/:_authToken=secret\n",
  });

  expect(message).toContain("generated paths must not be tracked");
  expect(message).toContain("only .dreamboard/project.json may be tracked");
  expect(message).toContain("credential-like files are not allowed");
  expect(message).toContain("credential-like content is not allowed");
});

test("exact commit source policy allows deterministic scaffold facade files", async () => {
  await assertExactCommitSourcePolicy({
    worktreeRoot: "/repo",
    entries: [
      blob("shared/generated/ui-contract.ts"),
      blob("app/index.ts"),
      blob("shared/manifest-runtime.ts"),
      blob("ui/tsconfig.framework.json"),
    ],
    readFile: async () => Buffer.from("export {};\n"),
  });
});

test("exact commit verifier removes detached worktree when policy rejects the commit", async () => {
  const calls: string[] = [];
  const git = {
    async resolveCommit() {
      return "commit-1";
    },
    async remoteUrl() {
      return null;
    },
    async createDetachedWorktree(
      _root: string,
      _commitOid: string,
      destination: string,
    ) {
      calls.push(`add:${destination}`);
    },
    async removeWorktree(_root: string, destination: string) {
      calls.push(`remove:${destination}`);
    },
  };

  await expect(
    runExactCommitVerification(
      {
        projectRoot: "/repo",
        config: {
          environment: "prod",
          apiBaseUrl: "https://api.example.com",
          webBaseUrl: "https://web.example.com",
          authTokenSource: "none",
          refreshTokenSource: "none",
        },
        commitOid: "commit-1",
        hook: false,
      },
      {
        git,
        makeTempDir: async () => "/tmp/dreamboard-verify-test",
        readGitTree: async () => [blob(".gitmodules")],
        readPolicyFile: async () => Buffer.from("", "utf8"),
      },
    ),
  ).rejects.toThrow(".gitmodules is not allowed");

  expect(calls).toEqual([
    "add:/tmp/dreamboard-verify-test/worktree",
    "remove:/tmp/dreamboard-verify-test/worktree",
  ]);
});

test("exact commit verifier runs the successful pipeline inside the detached worktree", async () => {
  const calls: string[] = [];
  const projectConfig = {
    schemaVersion: 2,
    projectId: "project-1",
    slug: "project-1",
    compile: {
      latestSuccessful: {
        resultId: "compiled-1",
        revisionDigest: "revision-digest-1",
      },
    },
  };
  const git = {
    async resolveCommit() {
      return "commit-1";
    },
    async remoteUrl() {
      return null;
    },
    async createDetachedWorktree(
      _root: string,
      _commitOid: string,
      destination: string,
    ) {
      calls.push(`add:${destination}`);
    },
    async removeWorktree(_root: string, destination: string) {
      calls.push(`remove:${destination}`);
    },
  };

  const result = await runExactCommitVerification(
    {
      projectRoot: "/repo",
      config: {
        environment: "prod",
        apiBaseUrl: "https://api.example.com",
        webBaseUrl: "https://web.example.com",
        authTokenSource: "none",
        refreshTokenSource: "none",
      },
      commitOid: "commit-1",
      hook: false,
    },
    {
      git,
      makeTempDir: async () => "/tmp/dreamboard-verify-success",
      readGitTree: async () => [blob(".dreamboard/project.json"), blob("app/game.ts")],
      readPolicyFile: async () => Buffer.from("export {}\n", "utf8"),
      loadProjectConfig: async (root) => {
        calls.push(`config:${root}`);
        return projectConfig;
      },
      assertPortableDependencies: async ({ projectRoot }) => {
        calls.push(`portable:${projectRoot}`);
      },
      runInstall: async (root) => {
        calls.push(`install:${root}`);
      },
      loadManifest: async (root) => {
        calls.push(`manifest:${root}`);
        return { manifest: true };
      },
      applyCodegen: async ({ projectRoot }) => {
        calls.push(`codegen:${projectRoot}`);
      },
      assertContract: async (root) => {
        calls.push(`contract:${root}`);
      },
      runTypecheck: async (root) => {
        calls.push(`typecheck:${root}`);
        return { skipped: false, success: true };
      },
      assertReducerBundle: async ({ projectRoot }) => {
        calls.push(`bundle:${projectRoot}`);
      },
      isTestingWorkspace: async (root) => {
        calls.push(`is-testing:${root}`);
        return true;
      },
      generateArtifacts: async ({ projectRoot, projectId, compiledResultId }) => {
        calls.push(`generate:${projectRoot}:${projectId}:${compiledResultId}`);
        return { bases: [{}], scenarios: [{}] };
      },
      runScenarios: async ({
        projectRoot,
        projectConfig: scenarioProjectConfig,
        projectId,
        compiledResultId,
      }) => {
        calls.push(
          `scenarios:${projectRoot}:${scenarioProjectConfig.projectId}:${projectId}:${compiledResultId}`,
        );
        return {
          passed: 1,
          failed: 0,
          results: [{ id: "scenario-1", success: true }],
        };
      },
    },
  );

  expect(result).toMatchObject({
    projectId: "project-1",
    commitOid: "commit-1",
    status: "passed",
    scenarioSummary: {
      passed: 1,
      failed: 0,
      total: 1,
    },
  });
  expect(calls).toEqual([
    "add:/tmp/dreamboard-verify-success/worktree",
    "config:/tmp/dreamboard-verify-success/worktree",
    "portable:/tmp/dreamboard-verify-success/worktree",
    "install:/tmp/dreamboard-verify-success/worktree",
    "manifest:/tmp/dreamboard-verify-success/worktree",
    "codegen:/tmp/dreamboard-verify-success/worktree",
    "contract:/tmp/dreamboard-verify-success/worktree",
    "typecheck:/tmp/dreamboard-verify-success/worktree",
    "bundle:/tmp/dreamboard-verify-success/worktree",
    "is-testing:/tmp/dreamboard-verify-success/worktree",
    "generate:/tmp/dreamboard-verify-success/worktree:project-1:compiled-1",
    "scenarios:/tmp/dreamboard-verify-success/worktree:project-1:project-1:compiled-1",
    "remove:/tmp/dreamboard-verify-success/worktree",
  ]);
});
