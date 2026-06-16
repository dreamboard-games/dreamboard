import { DEFAULT_WEB_BASE_URL } from "../../constants.js";

export const DEPENDENCY_SETUP_DOCS_PATH = "/docs/reference/dependency-setup";
export const DEPENDENCY_SETUP_DOCS_URL = `${DEFAULT_WEB_BASE_URL}${DEPENDENCY_SETUP_DOCS_PATH}`;

export function buildMissingDependencyToolingMessage(): string {
  return [
    "Dreamboard needs dependency tooling to finish `dreamboard sync`.",
    "Use Node 24+ with Corepack enabled, then run `dreamboard sync` again.",
    "If Corepack is unavailable on this machine, install pnpm globally with `npm install -g pnpm`.",
    `Help: ${DEPENDENCY_SETUP_DOCS_URL}`,
  ].join("\n");
}

export function buildPackageLockConflictMessage(): string {
  return [
    "Dreamboard manages workspace dependencies during `dreamboard sync`.",
    "This workspace has an npm lockfile that conflicts with Dreamboard-managed dependencies.",
    "Remove `package-lock.json` and run `dreamboard sync` again.",
    `Help: ${DEPENDENCY_SETUP_DOCS_URL}`,
  ].join("\n");
}

export function buildMissingGeneratedLockfileMessage(): string {
  return [
    "Dreamboard could not finish preparing workspace dependencies during `dreamboard sync`.",
    "Diagnostic: `pnpm-lock.yaml` was not created.",
    `Help: ${DEPENDENCY_SETUP_DOCS_URL}`,
  ].join("\n");
}

export function buildDependencyPreparationFailureMessage(options: {
  output?: string;
  exitCode?: number | null;
}): string {
  const details = options.output?.trim();
  return [
    `Dreamboard could not finish preparing workspace dependencies during \`dreamboard sync\`${options.exitCode != null ? ` (exit code ${options.exitCode})` : ""}.`,
    details ? `Diagnostic output:\n${details}` : null,
    `Help: ${DEPENDENCY_SETUP_DOCS_URL}`,
  ]
    .filter(Boolean)
    .join("\n");
}
