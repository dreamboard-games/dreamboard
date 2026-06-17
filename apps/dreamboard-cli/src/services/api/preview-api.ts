import { uploadProjectInitialProjection } from "@dreamboard-games/api-client";
import { toDreamboardApiError } from "../../utils/errors.js";

export async function uploadInitialProjectionSdk(
  gameId: string,
  projectionJson: string,
): Promise<void> {
  const { error, response } = await uploadProjectInitialProjection({
    path: { projectId: gameId },
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
