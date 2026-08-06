import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

describe("the application's version", () => {
  it("resolves to a real version, not to nothing", () => {
    // It comes from a JSON import, which a bundler can resolve to undefined without failing: the window would
    // then read "ZAX undefined" and the update check would compare against it.
    expect(VERSION).toMatch(/^\d+\.\d+/);
  });
});
