import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILD, VERSION } from "./version.js";

describe("the application's version", () => {
  it("resolves to a real version, not to nothing", () => {
    // It comes from a JSON import, which a bundler can resolve to undefined without failing: the window would
    // then read "ZAX undefined" and the update check would compare against it.
    expect(VERSION).toMatch(/^\d+\.\d+/);
  });
});

describe("the label a build shows", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /*
    The build replaces `__ZAX_COMMIT__` with a literal, so nothing defines it here - which is the case worth
    pinning: read as a bare identifier it would throw on import and take every module that imports it with it.
  */
  it("is the plain version when the build did not say which commit it came from", () => {
    expect(BUILD).toBe(VERSION);
  });

  it("carries the commit as a pre-release suffix, so it still sorts against the releases", async () => {
    vi.resetModules();
    vi.stubGlobal("__ZAX_COMMIT__", "c295f20");
    const fresh = (await import("./version.js")) as { BUILD: string; VERSION: string };
    expect(fresh.BUILD).toBe(`${fresh.VERSION}-c295f20`);
    expect(fresh.BUILD).toMatch(/^\d+\.\d+\.\d+-[0-9a-f]{7,}$/);
  });
});
