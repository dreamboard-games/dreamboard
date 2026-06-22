import { constants, existsSync, statSync } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const args = new Set(Bun.argv.slice(2));
const mode = args.has("--check") ? "check" : "write";
const outputRoot =
  mode === "check"
    ? await mkdtemp(path.join(os.tmpdir(), "dreamboard-api-client-check-"))
    : await mkdtemp(path.join(os.tmpdir(), "dreamboard-api-client-generate-"));
const srcRoot = path.join(outputRoot, "src");
const generatedDirectories = ["@tanstack", "client", "core", "generated"];
const generatedPaths = [
  "src/@tanstack",
  "src/client",
  "src/core",
  "src/generated/problem-types.gen.ts",
  "src/client.gen.ts",
  "src/game-revisions.ts",
  "src/index.ts",
  "src/sdk.gen.ts",
  "src/source-revisions.ts",
  "src/storage-paths.ts",
  "src/types.gen.ts",
  "src/zod.gen.ts",
];

await Promise.all(
  generatedDirectories.map((relativePath) =>
    mkdir(path.join(srcRoot, relativePath), { recursive: true }),
  ),
);

const command = Bun.spawn(["pnpm", "exec", "openapi-ts"], {
  cwd: packageRoot,
  env: {
    ...Bun.env,
    DREAMBOARD_GENERATED_OUTPUT_ROOT: srcRoot,
  },
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await command.exited;
if (exitCode !== 0) {
  process.exit(exitCode);
}

async function rewriteRelativeImportSpecifiersToJs(
  directory: string,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });

  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        await rewriteRelativeImportSpecifiersToJs(entryPath);
        return;
      }

      if (!entry.isFile() || !entry.name.endsWith(".ts")) {
        return;
      }

      const original = await readFile(entryPath, "utf8");
      const resolveSpecifier = (specifier: string): string => {
        if (/\.(?:[cm]?js|[cm]?ts|json|css)$/.test(specifier)) {
          return specifier;
        }

        const resolvedPath = path.resolve(path.dirname(entryPath), specifier);
        if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
          if (
            existsSync(path.join(resolvedPath, "index.ts")) ||
            existsSync(path.join(resolvedPath, "index.js"))
          ) {
            return `${specifier}/index.js`;
          }
        }

        return `${specifier}.js`;
      };
      const patched = original.replace(
        /(from\s+['"])(\.\.?\/[^'"]+?)(['"])/g,
        (full, prefix, specifier, suffix) =>
          `${prefix}${resolveSpecifier(specifier)}${suffix}`,
      );

      if (patched !== original) {
        await Bun.write(entryPath, patched);
      }
    }),
  );
}

await rewriteRelativeImportSpecifiersToJs(srcRoot);

async function patchChoiceDomainOptionNullability(): Promise<void> {
  const replacements: Array<[string, Array<[RegExp, string]>]> = [
    [
      "src/types.gen.ts",
      [
        [
          /export type ChoiceDomainOption = \{\n    value: string;/,
          "export type ChoiceDomainOption = {\n    value: string | null;",
        ],
      ],
    ],
    [
      "src/zod.gen.ts",
      [
        [
          /export const zChoiceDomainOption = z\.object\(\{\n    value: z\.string\(\),/,
          "export const zChoiceDomainOption = z.object({\n    value: z.nullable(z.string()),",
        ],
      ],
    ],
  ];

  for (const [relativePath, fileReplacements] of replacements) {
    const target = path.join(outputRoot, relativePath);
    let content = await readFile(target, "utf8");
    for (const [pattern, replacement] of fileReplacements) {
      content = content.replace(pattern, replacement);
    }
    await Bun.write(target, content);
  }
}

await patchChoiceDomainOptionNullability();

async function stripGeneratedSseClientSurface(): Promise<void> {
  const clientPath = path.join(srcRoot, "client", "client.gen.ts");
  const typesPath = path.join(srcRoot, "client", "types.gen.ts");

  let clientSource = await readFile(clientPath, "utf8");
  clientSource = clientSource
    .replace(
      /import \{ createSseClient \} from '\.\.\/core\/serverSentEvents\.gen\.js';\n/,
      "",
    )
    .replace("    // @ts-expect-error\n", "")
    .replace(
      /\n  const makeSseFn =\n    \(method: Uppercase<HttpMethod>\) => async \(options: RequestOptions\) => \{[\s\S]*?\n    \};\n(?=\n  return \{)/,
      "\n",
    )
    .replace(
      /\n    sse: \{\n      connect: makeSseFn\('CONNECT'\),\n      delete: makeSseFn\('DELETE'\),\n      get: makeSseFn\('GET'\),\n      head: makeSseFn\('HEAD'\),\n      options: makeSseFn\('OPTIONS'\),\n      patch: makeSseFn\('PATCH'\),\n      post: makeSseFn\('POST'\),\n      put: makeSseFn\('PUT'\),\n      trace: makeSseFn\('TRACE'\),\n    \},/,
      "",
    );
  await Bun.write(clientPath, clientSource);

  let typesSource = await readFile(typesPath, "utf8");
  typesSource = typesSource
    .replace(
      /import type \{\n  ServerSentEventsOptions,\n  ServerSentEventsResult,\n\} from '\.\.\/core\/serverSentEvents\.gen\.js';\n/,
      "",
    )
    .replace(
      /\n    Pick<\n      ServerSentEventsOptions<TData>,\n      \| 'onSseError'\n      \| 'onSseEvent'\n      \| 'sseDefaultRetryDelay'\n      \| 'sseMaxRetryAttempts'\n      \| 'sseMaxRetryDelay'\n    > /,
      " ",
    )
    .replace(/(\n    \}>), \{/, "$1 {")
    .replace(
      /\ntype SseFn = <\n  TData = unknown,\n  TError = unknown,\n  ThrowOnError extends boolean = false,\n  TResponseStyle extends ResponseStyle = 'fields',\n>\(\n  options: Omit<RequestOptions<TData, TResponseStyle, ThrowOnError>, 'method'>,\n\) => Promise<ServerSentEventsResult<TData, TError>>;\n/,
      "",
    )
    .replace(
      /export type Client = CoreClient<\n  RequestFn,\n  Config,\n  MethodFn,\n  BuildUrlFn,\n  SseFn\n>/,
      "export type Client = CoreClient<RequestFn, Config, MethodFn, BuildUrlFn>",
    )
    .replace(/\n  sse: \{\n    connect: Client['connect'];[\s\S]*?\n  \};/, "");
  await Bun.write(typesPath, typesSource);

  await rm(path.join(srcRoot, "core", "serverSentEvents.gen.ts"), {
    force: true,
  });
}

await stripGeneratedSseClientSurface();

await Bun.write(
  path.join(srcRoot, "storage-paths.ts"),
  `/**
 * Storage path constants shared between frontend and backend.
 * These mirror the values in the Kotlin StoragePathUtils.
 */

/**
 * Storage bucket for compiled scripts (game logic and UI bundles)
 */
export const STORAGE_BUCKET = "scripts";

/**
 * Directory name for source files
 */
export const SOURCE_DIR = "src";

/**
 * Directory name for compiled output
 */
export const DIST_DIR = "dist";
`,
);

await Bun.write(
  path.join(srcRoot, "source-revisions.ts"),
  `import { createProjectSourceBlobUploadSession } from "./sdk.gen.js";
import type {
  SourceBlobUploadDescriptor,
  SourceBlobUploadSession,
  SourceBlobUploadTarget,
  SourceChangeOperation,
} from "./types.gen.js";

export type SourceContentChangeOperation =
  | {
      kind: "upsert";
      path: string;
      content: string;
    }
  | {
      kind: "delete";
      path: string;
    };

const textEncoder = new TextEncoder();

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const normalizedBytes = new Uint8Array(bytes.byteLength);
  normalizedBytes.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    normalizedBytes.buffer,
  );
  return bytesToHex(new Uint8Array(digest));
}

function getUtf8ByteSize(content: string): number {
  return textEncoder.encode(content).byteLength;
}

async function computeSourceContentHash(content: string): Promise<string> {
  return sha256Hex(textEncoder.encode(content));
}

async function describeSourceBlob(
  content: string,
): Promise<SourceBlobUploadDescriptor> {
  return {
    contentHash: await computeSourceContentHash(content),
    byteSize: getUtf8ByteSize(content),
  };
}

export async function materializeSourceChangeOperations(
  changes: Iterable<SourceContentChangeOperation>,
): Promise<{
  blobs: SourceBlobUploadDescriptor[];
  changes: SourceChangeOperation[];
}> {
  const blobsByHash = new Map<string, SourceBlobUploadDescriptor>();
  const materialized = await Promise.all(
    Array.from(changes, async (change): Promise<SourceChangeOperation> => {
      if (change.kind === "delete") {
        return change;
      }

      const blob = await describeSourceBlob(change.content);
      const existing = blobsByHash.get(blob.contentHash);
      if (!existing) {
        blobsByHash.set(blob.contentHash, blob);
      }

      return {
        kind: "upsert",
        path: change.path,
        contentHash: blob.contentHash,
        byteSize: blob.byteSize,
      };
    }),
  );

  return {
    blobs: Array.from(blobsByHash.values()).sort((left, right) =>
      left.contentHash.localeCompare(right.contentHash),
    ),
    changes: materialized,
  };
}

export type SourceBlobUploadInput = SourceBlobUploadDescriptor & {
  content: string;
};

export function mapUpsertBlobContentsByContentHash(
  localChanges: readonly SourceContentChangeOperation[],
  materializedChanges: readonly SourceChangeOperation[],
): Map<string, SourceBlobUploadInput> {
  const uploadBlobs = new Map<string, SourceBlobUploadInput>();
  const length = Math.min(localChanges.length, materializedChanges.length);
  for (let index = 0; index < length; index += 1) {
    const localChange = localChanges[index];
    const materializedChange = materializedChanges[index];
    if (
      localChange?.kind !== "upsert" ||
      materializedChange?.kind !== "upsert"
    ) {
      continue;
    }

    uploadBlobs.set(materializedChange.contentHash, {
      contentHash: materializedChange.contentHash,
      byteSize: materializedChange.byteSize,
      content: localChange.content,
    });
  }

  return uploadBlobs;
}

class SourceBlobUploadError extends Error {
  readonly status: number;
  readonly details: string;

  constructor(status: number, details: string) {
    const suffix = details.trim().length > 0 ? \`: \${details.trim()}\` : "";
    super(\`Failed to upload source blob (HTTP \${status}\${suffix})\`);
    this.name = "SourceBlobUploadError";
    this.status = status;
    this.details = details;
  }
}

function isDuplicateDirectUploadError(
  error: unknown,
): error is SourceBlobUploadError {
  if (!(error instanceof SourceBlobUploadError)) {
    return false;
  }

  if (error.status === 409) {
    return true;
  }

  const normalizedDetails = error.details.toLowerCase();
  return (
    normalizedDetails.includes("duplicate") ||
    normalizedDetails.includes("already exists") ||
    normalizedDetails.includes("resource already exists")
  );
}

async function uploadSourceBlob(
  uploadTarget: SourceBlobUploadTarget,
  content: string,
): Promise<void> {
  const response = await fetch(uploadTarget.url, {
    method: uploadTarget.method,
    headers: uploadTarget.headers,
    body: textEncoder.encode(content),
  });

  if (response.ok) {
    return;
  }

  const details = await response.text().catch(() => "");
  throw new SourceBlobUploadError(response.status, details);
}

export class SourceBlobSessionRequestError extends Error {
  readonly apiError: unknown;
  readonly response: Response | undefined;

  constructor(
    message: string,
    apiError: unknown,
    response: Response | undefined,
  ) {
    super(message);
    this.name = "SourceBlobSessionRequestError";
    this.apiError = apiError;
    this.response = response;
  }
}

function assertSourceBlobUploadSession(
  data: unknown,
  response: Response | undefined,
): asserts data is SourceBlobUploadSession {
  if (
    !data ||
    typeof data !== "object" ||
    !Array.isArray((data as { uploads?: unknown }).uploads)
  ) {
    throw new SourceBlobSessionRequestError(
      "Source blob upload session response did not include an uploads array",
      data,
      response,
    );
  }
}

type SourceBlobUploadSessionRequester = (
  blobs: SourceBlobUploadDescriptor[],
) => Promise<{
  data: unknown;
  error: unknown;
  response: Response | undefined;
}>;

async function confirmSourceBlobAlreadyExists(options: {
  requestUploadSession: SourceBlobUploadSessionRequester;
  blob: SourceBlobUploadInput;
}): Promise<boolean> {
  const { requestUploadSession, blob } = options;
  const { data, error, response } = await requestUploadSession([
    {
      contentHash: blob.contentHash,
      byteSize: blob.byteSize,
    },
  ]);

  if (error || !data) {
    throw new SourceBlobSessionRequestError(
      "Failed to create source blob upload session",
      error,
      response,
    );
  }
  assertSourceBlobUploadSession(data, response);

  return data.uploads[0]?.status === "exists";
}

async function uploadSourceBlobs(options: {
  blobs: SourceBlobUploadInput[];
  requestUploadSession: SourceBlobUploadSessionRequester;
}): Promise<void> {
  const { blobs, requestUploadSession } = options;
  const uniqueBlobs = new Map<string, SourceBlobUploadInput>();
  for (const blob of blobs) {
    const existing = uniqueBlobs.get(blob.contentHash);
    if (!existing) {
      uniqueBlobs.set(blob.contentHash, blob);
      continue;
    }

    if (existing.byteSize !== blob.byteSize) {
      throw new Error(
        \`Source blob \${blob.contentHash} has conflicting byte sizes.\`,
      );
    }
  }

  if (uniqueBlobs.size === 0) {
    return;
  }

  const { data, error, response } = await requestUploadSession(
    Array.from(uniqueBlobs.values(), ({ contentHash, byteSize }) => ({
      contentHash,
      byteSize,
    })),
  );

  if (error || !data) {
    throw new SourceBlobSessionRequestError(
      "Failed to create source blob upload session",
      error,
      response,
    );
  }
  assertSourceBlobUploadSession(data, response);

  for (const upload of data.uploads) {
    if (upload.status !== "upload_required") {
      continue;
    }

    const blob = uniqueBlobs.get(upload.contentHash);
    if (!blob) {
      throw new Error(
        \`Upload session referenced unknown source blob \${upload.contentHash}.\`,
      );
    }
    if (!upload.uploadTarget) {
      throw new Error(
        \`Upload target missing for source blob \${upload.contentHash}.\`,
      );
    }

    try {
      await uploadSourceBlob(upload.uploadTarget, blob.content);
      if (!(await confirmSourceBlobAlreadyExists({ requestUploadSession, blob }))) {
        throw new Error(
          \`Source blob \${blob.contentHash} was uploaded but not registered.\`,
        );
      }
    } catch (error) {
      if (
        isDuplicateDirectUploadError(error) &&
        (await confirmSourceBlobAlreadyExists({ requestUploadSession, blob }))
      ) {
        continue;
      }
      throw error;
    }
  }
}

export async function uploadProjectSourceBlobs(options: {
  projectId: string;
  blobs: SourceBlobUploadInput[];
}): Promise<void> {
  const { projectId, blobs } = options;
  return uploadSourceBlobs({
    blobs,
    requestUploadSession: (uploadBlobs) =>
      createProjectSourceBlobUploadSession({
        path: { projectId },
        body: { blobs: uploadBlobs },
      }),
  });
}
`,
);

await Bun.write(
  path.join(srcRoot, "game-revisions.ts"),
  `export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type RevisionDigestInput = {
  sourceTreeHash: string;
  ruleContentHash: string;
  manifestContentHash: string;
};

const textEncoder = new TextEncoder();

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export async function computeRevisionDigest(
  input: RevisionDigestInput,
): Promise<\`sha256:\${string}\`> {
  const canonical = canonicalJson({
    format: "dreamboard.game-revision/v1",
    sourceTreeHash: input.sourceTreeHash,
    ruleContentHash: input.ruleContentHash,
    manifestContentHash: input.manifestContentHash,
  });
  return \`sha256:\${await sha256Hex(textEncoder.encode(canonical))}\`;
}

function canonicalize(value: JsonValue): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("JSON numbers must be finite");
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("JSON integer values must be safe JavaScript integers");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const normalizedBytes = new Uint8Array(bytes.byteLength);
  normalizedBytes.set(bytes);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    normalizedBytes.buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
`,
);

function extractProblemTypeValues(source: string): string[] {
  const match = source.match(
    /export const zProblemType = z\.enum\(\[\n([\s\S]*?)\n\]\);/,
  );
  if (!match) {
    throw new Error(
      "Unable to find zProblemType enum in generated zod module.",
    );
  }
  return Array.from(match[1].matchAll(/'([^']+)'/g), (entry) => entry[1]);
}

function toProblemTypeKey(value: string): string {
  return value
    .replace(/^urn:dreamboard:problem:/, "")
    .replace(/-/g, "_")
    .toUpperCase();
}

const serverProblemTypes = extractProblemTypeValues(
  await readFile(path.join(srcRoot, "zod.gen.ts"), "utf8"),
)
  .map((value) => `  ${toProblemTypeKey(value)}: ${JSON.stringify(value)},`)
  .join("\n");

await Bun.write(
  path.join(srcRoot, "generated", "problem-types.gen.ts"),
  `// This file is auto-generated by packages/api-client/scripts/generate.ts.
// Do not edit by hand.

import type { ProblemType } from "../types.gen.js";

export const SERVER_PROBLEM_TYPES = {
${serverProblemTypes}
} as const satisfies Record<string, ProblemType>;

export type ServerProblemType =
  (typeof SERVER_PROBLEM_TYPES)[keyof typeof SERVER_PROBLEM_TYPES];

export const CLIENT_PROBLEM_TYPES = {
  TRANSPORT_ERROR: "urn:dreamboard:problem:transport-error",
  UNKNOWN_API_ERROR: "urn:dreamboard:problem:unknown-api-error",
} as const;

export type ClientProblemType =
  (typeof CLIENT_PROBLEM_TYPES)[keyof typeof CLIENT_PROBLEM_TYPES];

export type AnyProblemType = ProblemType | ClientProblemType;
`,
);

const indexPath = path.join(srcRoot, "index.ts");
const indexContents = await readFile(indexPath, "utf8");
const extraExports = `\nexport { CLIENT_PROBLEM_TYPES, SERVER_PROBLEM_TYPES, type AnyProblemType, type ClientProblemType, type ServerProblemType } from './generated/problem-types.gen.js';\n`;
if (!indexContents.includes("./generated/problem-types.gen.js")) {
  await Bun.write(indexPath, `${indexContents}${extraExports}`);
}

await rewriteRelativeImportSpecifiersToJs(srcRoot);

const mismatches = [];
for (const generatedPath of generatedPaths) {
  const pathMismatches = await compareGeneratedTrees({
    expectedRoot: path.join(packageRoot, generatedPath),
    actualRoot: path.join(outputRoot, generatedPath),
  });
  mismatches.push(
    ...pathMismatches.map((mismatch) => ({
      ...mismatch,
      relativePath: mismatch.relativePath
        ? `${generatedPath}/${mismatch.relativePath}`
        : generatedPath,
    })),
  );
}

if (mode === "check") {
  await rm(outputRoot, { recursive: true, force: true });
  if (mismatches.length > 0) {
    throw new Error(renderGeneratedTreeMismatches(mismatches));
  }
} else {
  await replaceGeneratedPaths({
    sourceRoot: outputRoot,
    destinationRoot: packageRoot,
    paths: generatedPaths,
  });
  await rm(outputRoot, { recursive: true, force: true });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as { code?: string })?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readGeneratedTree(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();

  if (!(await pathExists(root))) {
    return files;
  }

  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error("Generated tree contains symlink: .");
  }
  if (rootStat.isFile()) {
    files.set("", await readFile(root));
    return files;
  }

  async function visit(directory: string, relativeDirectory: string) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = (
        relativeDirectory ? path.join(relativeDirectory, entry.name) : entry.name
      )
        .split(path.sep)
        .join("/");
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Generated tree contains symlink: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      if (stat.isFile()) {
        files.set(relativePath, await readFile(absolutePath));
      }
    }
  }

  await visit(root, "");
  return files;
}

async function compareGeneratedTrees(options: {
  expectedRoot: string;
  actualRoot: string;
}): Promise<Array<{ relativePath: string; kind: string }>> {
  const [expected, actual] = await Promise.all([
    readGeneratedTree(options.expectedRoot),
    readGeneratedTree(options.actualRoot),
  ]);
  const paths = [...new Set([...expected.keys(), ...actual.keys()])].sort();
  const mismatches = [];

  for (const relativePath of paths) {
    const expectedBytes = expected.get(relativePath);
    const actualBytes = actual.get(relativePath);
    if (!expectedBytes) {
      mismatches.push({ relativePath, kind: "unexpected-generated-file" });
    } else if (!actualBytes) {
      mismatches.push({ relativePath, kind: "missing-generated-file" });
    } else if (!expectedBytes.equals(actualBytes)) {
      mismatches.push({ relativePath, kind: "content-drift" });
    }
  }

  return mismatches;
}

async function replaceGeneratedPaths(options: {
  sourceRoot: string;
  destinationRoot: string;
  paths: string[];
}): Promise<void> {
  for (const generatedPath of options.paths) {
    const source = path.join(options.sourceRoot, generatedPath);
    const destination = path.join(options.destinationRoot, generatedPath);
    await mkdir(path.dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await cp(source, destination, {
      recursive: true,
      force: true,
      verbatimSymlinks: false,
    });
  }
}

function renderGeneratedTreeMismatches(
  mismatches: Array<{ relativePath: string; kind: string }>,
): string {
  return [
    `public-api-client-typescript: generated output drifted with ${mismatches.length} mismatch(es).`,
    ...mismatches.map(
      (mismatch) => `- ${mismatch.kind}: ${mismatch.relativePath}`,
    ),
    "Regenerate with: pnpm --dir packages/api-client generate",
  ].join("\n");
}
