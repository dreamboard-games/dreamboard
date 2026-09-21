import { describe, expect, it } from "vitest";
import {
  ClientGameplayFrameSchema,
  AuthRefreshFrameSchema,
  HistoryRestoreRejectedFrameSchema,
} from "./frames.js";
describe("direct gameplay protocol", () => {
  it("accepts credential connect and rejects legacy capability tokens", () => {
    expect(
      ClientGameplayFrameSchema.parse({
        type: "auth.connect",
        sessionId: "11111111-1111-4111-8111-111111111111",
        playerId: "p1",
        credential: { kind: "user", token: "jwt" },
      }).type,
    ).toBe("auth.connect");
    expect(() =>
      ClientGameplayFrameSchema.parse({
        type: "auth.connect",
        capabilityToken: "old",
      }),
    ).toThrow();
  });
  it("refresh cannot change a connection binding", () => {
    expect(
      AuthRefreshFrameSchema.parse({
        type: "auth.refresh",
        credential: { kind: "demo", secret: "secret" },
      }),
    ).toBeDefined();
    expect(() =>
      AuthRefreshFrameSchema.parse({
        type: "auth.refresh",
        playerId: "other",
        credential: { kind: "demo", secret: "secret" },
      }),
    ).toThrow();
  });
  it("restores by positive monotonic version", () => {
    expect(
      ClientGameplayFrameSchema.parse({
        type: "history.restore",
        restoreId: "r1",
        targetVersion: 1,
      }),
    ).toBeDefined();
    expect(() =>
      ClientGameplayFrameSchema.parse({
        type: "history.restore",
        restoreId: "r1",
        targetVersion: 0,
      }),
    ).toThrow();
  });
});

it("requires rejection correlation for history restores", () => {
  const rejection = {
    type: "history.restoreRejected",
    errorCode: "forbidden",
    message: "Permission denied",
  };
  expect(HistoryRestoreRejectedFrameSchema.safeParse(rejection).success).toBe(
    false,
  );
  expect(
    HistoryRestoreRejectedFrameSchema.safeParse({ ...rejection, restoreId: "" })
      .success,
  ).toBe(false);
  expect(
    HistoryRestoreRejectedFrameSchema.parse({ ...rejection, restoreId: "r1" })
      .restoreId,
  ).toBe("r1");
});
