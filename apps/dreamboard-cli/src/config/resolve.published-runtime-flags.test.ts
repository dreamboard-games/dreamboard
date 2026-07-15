import { expect, test } from "bun:test";
import { isAlphaReleaseVersion } from "../build-target.js";
import { assertPublicRuntimeFlags } from "./resolve.js";

test("published alpha versions are environment-selectable", () => {
  expect(isAlphaReleaseVersion("0.1.30-alpha.999")).toBe(true);
  expect(isAlphaReleaseVersion("1.0.0-beta.1")).toBe(false);
  expect(isAlphaReleaseVersion("1.0.0")).toBe(false);
});

test("published alpha builds allow explicit environment selection", () => {
  expect(() =>
    assertPublicRuntimeFlags(
      { env: "staging" },
      { canSelectEnvironment: true, argv: ["auth", "status", "--env"] },
    ),
  ).not.toThrow();
});

test("published stable builds reject explicit environment selection", () => {
  expect(() =>
    assertPublicRuntimeFlags(
      { env: "staging" },
      { canSelectEnvironment: false, argv: ["auth", "status", "--env"] },
    ),
  ).toThrow(
    "The published Dreamboard CLI is production-only and does not accept `--env`.",
  );
});
