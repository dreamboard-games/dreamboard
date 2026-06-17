import {
  defaultHostSessionTransport,
  type HostSessionTransport,
} from "@dreamboard-games/ui-host-runtime/runtime";

type HostSessionSnapshot = Awaited<
  ReturnType<HostSessionTransport["loadSessionSnapshot"]>
>;

type DevHostSessionSnapshot = HostSessionSnapshot & {
  context: HostSessionSnapshot["context"] & { seed?: number | null };
};

async function requestSnapshot(
  path: string,
  init: RequestInit,
): Promise<DevHostSessionSnapshot> {
  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    throw payload;
  }
  return payload as DevHostSessionSnapshot;
}

export function createDevHostSessionTransport(): HostSessionTransport {
  return {
    ...defaultHostSessionTransport,
    loadSessionSnapshot: async (input) =>
      requestSnapshot(
        input.requestedPlayerId?.trim()
          ? `/__dreamboard_dev/session/snapshot?playerId=${encodeURIComponent(input.requestedPlayerId.trim())}`
          : "/__dreamboard_dev/session/snapshot",
        { method: "GET" },
      ),
    startSession: async () =>
      requestSnapshot("/__dreamboard_dev/session/start", {
        method: "POST",
        body: undefined,
        headers: undefined,
      }),
    createDevSessionSnapshot: async (input) =>
      requestSnapshot("/__dreamboard_dev/session/new", {
        method: "POST",
        body: JSON.stringify({ seed: input.seed }),
        headers: { "content-type": "application/json" },
      }),
  };
}
