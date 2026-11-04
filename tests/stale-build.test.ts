import { describe, expect, it } from "vitest";
import { isStaleBuildError } from "../src/lib/stale-build";

describe("isStaleBuildError", () => {
  it("recognises errors from a new deployment clashing with an open app", () => {
    expect(isStaleBuildError(new Error("An unexpected response was received from the server."))).toBe(true);
    expect(isStaleBuildError(new Error('Failed to find Server Action "abc". This request might be from an older or newer deployment.'))).toBe(true);
    expect(isStaleBuildError(Object.assign(new Error("Loading chunk 1255 failed."), { name: "ChunkLoadError" }))).toBe(true);
    expect(isStaleBuildError(Object.assign(new Error('Server Action "609d" was not found on the server.'), { name: "UnrecognizedActionError" }))).toBe(true);
    expect(isStaleBuildError(new TypeError("Failed to fetch dynamically imported module: /x.js"))).toBe(true);
  });
  it("leaves ordinary errors alone", () => {
    expect(isStaleBuildError(new Error("Database error: timeout"))).toBe(false);
    expect(isStaleBuildError(null)).toBe(false);
  });
});
