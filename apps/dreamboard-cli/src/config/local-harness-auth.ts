import { createHmac, randomUUID } from "node:crypto";
import type { ResolvedConfig } from "../types.js";
import { IS_PUBLISHED_BUILD } from "../build-target.js";

type LocalHarnessProfile = "local" | "local-aws";

const DEFAULT_SUBJECT = "harness-smoke-local@dreamboard.local";
const DEFAULT_ISSUER = "dreamboard-local-harness";
const DEFAULT_SECRET = "dreamboard-local-harness-token-secret";
const LOCAL_AWS_ISSUER = "dreamboard-local-aws-harness";
const LOCAL_AWS_SECRET = "dreamboard-local-aws-harness-token-secret";
const DEFAULT_TTL_SECONDS = 8 * 60 * 60;

const mintedTokens = new Map<string, string>();

export function resolveLocalHarnessAccessToken(
  config: ResolvedConfig,
): string | undefined {
  if (IS_PUBLISHED_BUILD || config.environment !== "local") {
    return undefined;
  }

  const profile = inferLocalHarnessProfile(config);
  if (
    config.authToken &&
    (profile !== "local-aws" || isExplicitTokenSource(config.authTokenSource))
  ) {
    return undefined;
  }

  const cacheKey = [
    profile,
    process.env.LOCAL_HARNESS_TOKEN_ISSUER ?? "",
    process.env.LOCAL_HARNESS_TOKEN_SECRET ?? "",
    process.env.LOCAL_HARNESS_SUBJECT ?? "",
    process.env.HARNESS_USER_EMAIL ?? "",
    process.env.LOCAL_HARNESS_EMAIL ?? "",
    process.env.LOCAL_HARNESS_TOKEN_TTL_SECONDS ?? "",
  ].join("\0");
  const cached = mintedTokens.get(cacheKey);
  if (cached) return cached;

  const token = mintLocalHarnessToken(profile);
  mintedTokens.set(cacheKey, token);
  return token;
}

function isExplicitTokenSource(
  source: ResolvedConfig["authTokenSource"],
): boolean {
  return source === "flag" || source === "env" || source === "agent-env";
}

export function inferLocalHarnessProfile(
  config: Pick<ResolvedConfig, "apiBaseUrl" | "webBaseUrl">,
): LocalHarnessProfile {
  return isLocalAwsUrl(config.apiBaseUrl) || isLocalAwsUrl(config.webBaseUrl)
    ? "local-aws"
    : "local";
}

function mintLocalHarnessToken(profile: LocalHarnessProfile): string {
  const subject =
    envValue(process.env.LOCAL_HARNESS_SUBJECT) ??
    envValue(process.env.HARNESS_USER_EMAIL) ??
    DEFAULT_SUBJECT;
  const email =
    envValue(process.env.LOCAL_HARNESS_EMAIL) ??
    (subject.includes("@") ? subject : undefined);
  const issuer =
    envValue(process.env.LOCAL_HARNESS_TOKEN_ISSUER) ??
    (profile === "local-aws" ? LOCAL_AWS_ISSUER : DEFAULT_ISSUER);
  const secret =
    envValue(process.env.LOCAL_HARNESS_TOKEN_SECRET) ??
    (profile === "local-aws" ? LOCAL_AWS_SECRET : DEFAULT_SECRET);
  const ttlSeconds = Number(
    envValue(process.env.LOCAL_HARNESS_TOKEN_TTL_SECONDS) ??
      String(DEFAULT_TTL_SECONDS),
  );
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error(
      "LOCAL_HARNESS_TOKEN_TTL_SECONDS must be a positive number.",
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    typ: "local_harness_access",
    dreamboard_provider: "local-harness",
    dreamboard_provider_subject: subject,
    ...(email ? { email } : {}),
    iss: issuer,
    sub: subject,
    iat: now,
    exp: now + Math.floor(ttlSeconds),
    jti: randomUUID(),
  };

  const headerPart = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const payloadPart = base64UrlJson(payload);
  const signature = createHmac("sha256", secret)
    .update(`${headerPart}.${payloadPart}`)
    .digest("base64url");
  return `${headerPart}.${payloadPart}.${signature}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function envValue(raw: string | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0
    ? raw.trim()
    : undefined;
}

function isLocalAwsUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    return (
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      (url.port === "18080" || url.port === "8088")
    );
  } catch {
    return false;
  }
}
