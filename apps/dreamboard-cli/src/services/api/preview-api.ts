import { uploadProjectInitialProjection } from "@dreamboard-games/api-client";
import { toDreamboardApiError } from "../../utils/errors.js";

export async function uploadInitialProjectionSdk(
  projectId: string,
  projectionJson: string,
): Promise<void> {
  const { error, response } = await uploadProjectInitialProjection({
    path: { projectId },
    body: { projectionJson },
  });
  if (error) {
    throw toDreamboardApiError(
      error,
      response,
      "Failed to upload initial preview projection",
    );
  }
}
