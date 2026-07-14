import { createHash } from "node:crypto";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "..");
const openApiPath = path.join(packageRoot, "openapi", "documentation.yaml");
const sourceManifestPath = path.join(packageRoot, "openapi", "SOURCE.json");
const sha256Pattern = /^sha256:[0-9a-f]{64}$/;
const httpMethods = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "head",
  "options",
  "trace",
]);
const deletedRoutes = new Set([
  "/api/jobs/{jobId}/events",
  "/api/sessions/{sessionId}/events",
  "/api/sessions/{sessionId}/events/disconnect",
  "/api/sessions/{sessionId}/logs",
  "/api/sessions/{sessionId}/log-batches",
  "/api/demo/sessions/{sessionId}/log-batches",
  "/api/webhooks/stripe",
]);
const deletedOperationIds = new Set([
  "subscribeToJobEvents",
  "subscribeToSessionEvents",
  "disconnectSessionEvents",
  "subscribeToGameLogs",
  "getSessionEventBatch",
  "getSessionLogBatch",
  "getDemoSessionEventBatch",
  "getDemoSessionLogBatch",
  "receiveStripeBillingWebhook",
]);
const deletedSchemaNames = new Set([
  "LogMessageDto",
  "SessionLogBatchResponse",
]);

interface OpenApiDocument {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
  };
}

interface SourceManifest {
  schemaVersion?: unknown;
  sourceRepository?: unknown;
  sourceRevision?: unknown;
  sourceWorktreeStatus?: unknown;
  privateBundleSha256?: unknown;
  routePolicySha256?: unknown;
  clientAllowlistSha256?: unknown;
  publicOpenApiSha256?: unknown;
  operationCount?: unknown;
  publicClientRoutes?: unknown;
}

const [openApiText, manifestText] = await Promise.all([
  Bun.file(openApiPath).text(),
  Bun.file(sourceManifestPath).text(),
]);
const manifest = JSON.parse(manifestText) as SourceManifest;
const document = Bun.YAML.parse(openApiText) as OpenApiDocument;
const errors: string[] = [];

expectEqual("schemaVersion", manifest.schemaVersion, 1);
expectEqual("sourceRepository", manifest.sourceRepository, "internal");
expectString("sourceRevision", manifest.sourceRevision, /^[0-9a-f]{40}$/);
expectString(
  "sourceWorktreeStatus",
  manifest.sourceWorktreeStatus,
  /^(clean|dirty)$/,
);
expectString(
  "privateBundleSha256",
  manifest.privateBundleSha256,
  sha256Pattern,
);
expectString("routePolicySha256", manifest.routePolicySha256, sha256Pattern);
expectString(
  "clientAllowlistSha256",
  manifest.clientAllowlistSha256,
  sha256Pattern,
);
expectString(
  "publicOpenApiSha256",
  manifest.publicOpenApiSha256,
  sha256Pattern,
);

const actualOpenApiSha256 = sha256(openApiText);
if (manifest.publicOpenApiSha256 !== actualOpenApiSha256) {
  errors.push(
    `SOURCE.json publicOpenApiSha256 is ${manifest.publicOpenApiSha256}; expected ${actualOpenApiSha256}.`,
  );
}

const operations = collectOperations(document);
if (!Number.isInteger(manifest.operationCount) || manifest.operationCount < 1) {
  errors.push("SOURCE.json operationCount must be a positive integer.");
} else if (manifest.operationCount !== operations.length) {
  errors.push(
    `SOURCE.json operationCount is ${manifest.operationCount}; expected ${operations.length}.`,
  );
}
const manifestRoutes = Array.isArray(manifest.publicClientRoutes)
  ? manifest.publicClientRoutes
  : null;
if (!manifestRoutes) {
  errors.push("SOURCE.json publicClientRoutes must be an array.");
} else {
  const expectedRoutes = operations
    .map((operation) => ({
      method: operation.method.toUpperCase(),
      path: operation.path,
      operationId: operation.operationId,
    }))
    .sort(compareRoutes);
  const actualRoutes = manifestRoutes
    .map((route) => ({
      method:
        typeof (route as { method?: unknown }).method === "string"
          ? (route as { method: string }).method.toUpperCase()
          : "",
      path:
        typeof (route as { path?: unknown }).path === "string"
          ? (route as { path: string }).path
          : "",
      operationId:
        typeof (route as { operationId?: unknown }).operationId === "string"
          ? (route as { operationId: string }).operationId
          : "",
    }))
    .sort(compareRoutes);
  if (JSON.stringify(actualRoutes) !== JSON.stringify(expectedRoutes)) {
    errors.push(
      "SOURCE.json publicClientRoutes must exactly match public OpenAPI operations.",
    );
  }
}

for (const schemaName of Object.keys(document.components?.schemas ?? {})) {
  if (deletedSchemaNames.has(schemaName)) {
    errors.push(`Deleted public schema is still present: ${schemaName}.`);
  }
}

for (const operation of operations) {
  if (deletedRoutes.has(operation.path)) {
    errors.push(
      `Deleted public route is still present: ${operation.method.toUpperCase()} ${operation.path}.`,
    );
  }
  if (
    operation.path.toLowerCase().includes("realtime") ||
    operation.path.toLowerCase().includes("/log-batches")
  ) {
    errors.push(
      `Deleted realtime/log route is still present: ${operation.method.toUpperCase()} ${operation.path}.`,
    );
  }
  if (deletedOperationIds.has(operation.operationId)) {
    errors.push(
      `Deleted public operationId is still present: ${operation.operationId}.`,
    );
  }
}

if (errors.length > 0) {
  throw new Error(
    [
      "Public api-client contract source check failed:",
      ...errors.map((error) => `- ${error}`),
    ].join("\n"),
  );
}

process.stdout.write(
  `Public api-client contract source is valid (${operations.length} operations, ${actualOpenApiSha256}, source worktree ${manifest.sourceWorktreeStatus}).\n`,
);

function collectOperations(document: OpenApiDocument): Array<{
  path: string;
  method: string;
  operationId: string;
}> {
  const operations = [];
  for (const [routePath, routeOperations] of Object.entries(
    document.paths ?? {},
  )) {
    for (const [method, operation] of Object.entries(routeOperations ?? {})) {
      if (!httpMethods.has(method.toLowerCase())) {
        continue;
      }
      const operationId =
        typeof (operation as { operationId?: unknown }).operationId === "string"
          ? (operation as { operationId: string }).operationId
          : "";
      operations.push({ path: routePath, method, operationId });
    }
  }
  return operations;
}

function compareRoutes(
  left: { method: string; path: string; operationId: string },
  right: { method: string; path: string; operationId: string },
): number {
  const byPath = left.path.localeCompare(right.path);
  if (byPath !== 0) {
    return byPath;
  }
  const byMethod = left.method.localeCompare(right.method);
  return byMethod === 0
    ? left.operationId.localeCompare(right.operationId)
    : byMethod;
}

function expectEqual(name: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    errors.push(`SOURCE.json ${name} must be ${JSON.stringify(expected)}.`);
  }
}

function expectString(name: string, actual: unknown, pattern: RegExp): void {
  if (typeof actual !== "string" || !pattern.test(actual)) {
    errors.push(`SOURCE.json ${name} must match ${pattern}.`);
  }
}

function sha256(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
