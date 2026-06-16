import path from "node:path";
import { importTypeScriptModule } from "../../utils/ts-module-loader.js";

const GAME_CONTRACT_ENTRY_PATH = path.join("app", "game-contract.ts");

function normalizeErrorMessage(error: unknown): string {
  const rawMessage =
    error instanceof Error ? error.message : String(error ?? "Unknown error");
  return (
    rawMessage
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^Error:\s*/u, "") ?? "Unknown error"
  );
}

function isManifestScopedIdBrandingError(message: string): boolean {
  return (
    message.includes("defineGameContract:") &&
    message.includes("manifest-scoped") &&
    (message.includes("uses a raw z.string()") ||
      message.includes("uses z.array(z.string())"))
  );
}

export async function assertReducerContractPreflight(
  projectRoot: string,
): Promise<void> {
  const entryPath = path.join(projectRoot, GAME_CONTRACT_ENTRY_PATH);

  try {
    await importTypeScriptModule(entryPath);
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (isManifestScopedIdBrandingError(message)) {
      throw new Error(
        [
          `Dreamboard could not validate \`${GAME_CONTRACT_ENTRY_PATH}\` during \`dreamboard sync\`.`,
          "This happens because a state field name looks like a manifest-scoped id, but the schema uses a plain string instead of the manifest-backed id schema.",
          "Workaround: use `gameContract.schemas.<id>` (or `manifest.ids.<id>`) for manifest ids. If the field is intentionally free-form text, rename it so it does not look like a manifest id field.",
          `Original error: ${message}`,
        ].join(" "),
      );
    }

    throw new Error(
      [
        `Dreamboard could not validate \`${GAME_CONTRACT_ENTRY_PATH}\` during \`dreamboard sync\`.`,
        "Fix the authored reducer contract module so it can be imported locally, then run `dreamboard sync` again.",
        `Original error: ${message}`,
      ].join(" "),
    );
  }
}
