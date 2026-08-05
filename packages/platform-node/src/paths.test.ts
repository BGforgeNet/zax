import { describe, expect, it } from "vitest";
import { userDirectories } from "./paths.js";

/**
 * These are the locations `appdirs` picked for the previous implementation. Getting one wrong does not fail
 * loudly - it starts the application with an empty install list and silently writes a second `zax.yml` next to
 * the one the user already has - so each is pinned by value.
 */
describe("user directories", () => {
  it("uses roaming for config and local for cache on Windows", () => {
    const env = { APPDATA: "C:\\Users\\t\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local" };
    expect(userDirectories("win32", env, "C:\\Users\\t", "zax")).toEqual({
      config: "C:\\Users\\t\\AppData\\Roaming\\zax",
      cache: "C:\\Users\\t\\AppData\\Local\\zax\\Cache",
    });
  });

  it("falls back to the standard Windows layout when the environment does not say", () => {
    expect(userDirectories("win32", {}, "C:\\Users\\t", "zax").config).toBe("C:\\Users\\t\\AppData\\Roaming\\zax");
  });

  it("uses Application Support and Caches on macOS", () => {
    expect(userDirectories("darwin", {}, "/Users/t", "zax")).toEqual({
      config: "/Users/t/Library/Application Support/zax",
      cache: "/Users/t/Library/Caches/zax",
    });
  });

  it("uses the XDG layout elsewhere", () => {
    expect(userDirectories("linux", {}, "/home/t", "zax")).toEqual({
      config: "/home/t/.config/zax",
      cache: "/home/t/.cache/zax",
    });
  });

  it("honours XDG overrides, which is how a user relocates either directory", () => {
    const env = { XDG_CONFIG_HOME: "/mnt/cfg", XDG_CACHE_HOME: "/mnt/cache" };
    expect(userDirectories("linux", env, "/home/t", "zax")).toEqual({
      config: "/mnt/cfg/zax",
      cache: "/mnt/cache/zax",
    });
  });
});
