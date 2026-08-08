import { describe, expect, it } from "vitest";
import { applicationDirectories, launchDirectory, portableDirectory, userDirectories } from "./paths.js";

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

describe("where a copy was launched from", () => {
  it("takes the directory beside the executable", () => {
    expect(launchDirectory("linux", {}, "/opt/zax/zax")).toBe("/opt/zax");
    expect(launchDirectory("win32", {}, "D:\\Portable\\ZAX\\ZAX.exe")).toBe("D:\\Portable\\ZAX");
  });

  it("steps out of the bundle on macOS, so settings sit beside the application not inside it", () => {
    expect(launchDirectory("darwin", {}, "/Volumes/Stick/ZAX.app/Contents/MacOS/ZAX")).toBe("/Volumes/Stick");
  });

  it("believes the environment over the executable, which a portable build unpacks into a temporary directory", () => {
    const env = { PORTABLE_EXECUTABLE_DIR: "E:\\Stick" };
    expect(launchDirectory("win32", env, "C:\\Users\\t\\AppData\\Local\\Temp\\abc\\ZAX.exe")).toBe("E:\\Stick");
  });

  it("takes an AppImage's own path, since the running executable is inside a mount", () => {
    const env = { APPIMAGE: "/media/stick/ZAX-0.8.0.AppImage" };
    expect(launchDirectory("linux", env, "/tmp/.mount_ZAXabc/usr/bin/zax")).toBe("/media/stick");
  });
});

describe("deciding whether a copy is portable", () => {
  const noDirectories = () => false;

  it("is portable when a data directory sits beside it, which is the whole switch", () => {
    const isData = (path: string) => path === "/media/stick/data";
    expect(portableDirectory("linux", {}, "/media/stick", isData)).toBe("/media/stick/data");
  });

  it("is not portable without one, so an installed copy stays where the desktop puts it", () => {
    expect(portableDirectory("linux", {}, "/opt/zax", noDirectories)).toBeNull();
  });

  it("takes a directory named outright, for anyone scripting it", () => {
    const env = { ZAX_DATA_DIR: "/mnt/elsewhere" };
    expect(portableDirectory("linux", env, "/opt/zax", noDirectories)).toBe("/mnt/elsewhere");
  });

  it("looks for the data directory with the target's separator, not the host's", () => {
    const isData = (path: string) => path === "E:\\Stick\\data";
    expect(portableDirectory("win32", {}, "E:\\Stick", isData)).toBe("E:\\Stick\\data");
  });
});

/**
 * The whole decision, end to end. Each rule above is right on its own; these cover them being composed in the
 * right order, which is the part nothing else would catch - every one of them takes a path and returns a path,
 * so passing the wrong one typechecks.
 */
describe("which directories a copy actually uses", () => {
  const nothingExists = () => false;

  it("keeps config and cache beside the executable when a data directory is there", () => {
    const isData = (path: string) => path === "/media/stick/data";
    expect(applicationDirectories("linux", {}, "/home/t", "zax", "/media/stick/zax", isData)).toEqual({
      config: "/media/stick/data/config",
      cache: "/media/stick/data/cache",
    });
  });

  it("falls back to the per-user locations when there is none", () => {
    expect(applicationDirectories("linux", {}, "/home/t", "zax", "/opt/zax/zax", nothingExists)).toEqual({
      config: "/home/t/.config/zax",
      cache: "/home/t/.cache/zax",
    });
  });

  it("resolves a Windows portable build against where it was launched, not where it unpacked itself", () => {
    const env = { PORTABLE_EXECUTABLE_DIR: "E:\\Stick" };
    const isData = (path: string) => path === "E:\\Stick\\data";
    const held = applicationDirectories("win32", env, "C:\\Users\\t", "zax", "C:\\Temp\\x\\ZAX.exe", isData);
    expect(held).toEqual({ config: "E:\\Stick\\data\\config", cache: "E:\\Stick\\data\\cache" });
  });

  it("resolves an AppImage against the image's own path, not the mount it is running from", () => {
    const env = { APPIMAGE: "/media/stick/ZAX.AppImage" };
    const isData = (path: string) => path === "/media/stick/data";
    const held = applicationDirectories("linux", env, "/home/t", "zax", "/tmp/.mount_x/usr/bin/zax", isData);
    expect(held.config).toBe("/media/stick/data/config");
  });

  it("resolves a macOS bundle to the directory holding it, so moving the application keeps the settings", () => {
    const isData = (path: string) => path === "/Volumes/Stick/data";
    const execPath = "/Volumes/Stick/ZAX.app/Contents/MacOS/ZAX";
    const held = applicationDirectories("darwin", {}, "/Users/t", "zax", execPath, isData);
    expect(held.config).toBe("/Volumes/Stick/data/config");
  });

  it("takes a data directory named outright over anything beside the executable", () => {
    const env = { ZAX_DATA_DIR: "/mnt/elsewhere" };
    const isData = (path: string) => path === "/media/stick/data";
    const held = applicationDirectories("linux", env, "/home/t", "zax", "/media/stick/zax", isData);
    expect(held.config).toBe("/mnt/elsewhere/config");
  });

  it("separates config from cache, so emptying the cache cannot reach the install list", () => {
    const isData = (path: string) => path === "/media/stick/data";
    const { config, cache } = applicationDirectories("linux", {}, "/home/t", "zax", "/media/stick/zax", isData);
    expect(cache).not.toBe(config);
  });
});
