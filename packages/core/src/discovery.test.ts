import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { identifyInstall, scanForInstalls, scanRoots } from "./discovery.js";

/** A directory holding what makes it an install of one type. Marker files are empty; only presence is read. */
function install(root: string, marker?: "rpu.dat" | "upu.dat"): Record<string, string> {
  return { [`${root}/fallout2.exe`]: "MZ", ...(marker ? { [`${root}/mods/${marker}`]: "" } : {}) };
}

describe("identifying an install", () => {
  it("reads the type from what sits in the directory", async () => {
    const platform = new MemoryPlatform({
      files: { ...install("/games/vanilla"), ...install("/games/rpu", "rpu.dat"), ...install("/games/upu", "upu.dat") },
    });
    expect(await identifyInstall(platform, "/games/vanilla")).toBe("fallout2");
    expect(await identifyInstall(platform, "/games/rpu")).toBe("fallout2rpu");
    expect(await identifyInstall(platform, "/games/upu")).toBe("fallout2upu");
  });

  it("returns null for a directory that is not an install", async () => {
    const platform = new MemoryPlatform({ files: { "/games/other/readme.txt": "" } });
    expect(await identifyInstall(platform, "/games/other")).toBeNull();
  });

  it("returns null rather than failing for a path that is gone, which an unplugged drive looks like", async () => {
    expect(await identifyInstall(new MemoryPlatform(), "/mnt/usb/Fallout 2")).toBeNull();
  });

  it("returns null for a file, not only for a missing path", async () => {
    const platform = new MemoryPlatform({ files: { "/games/notes.txt": "" } });
    expect(await identifyInstall(platform, "/games/notes.txt")).toBeNull();
  });
});

describe("scanning", () => {
  it("looks under the home directory and the Wine drive, and only on drives on Windows", () => {
    const posix = new MemoryPlatform({ home: "/home/t" });
    expect(scanRoots(posix)).toEqual(["/home/t", "/home/t/.wine/drive_c"]);
    expect(scanRoots(posix, "/home/t/.wine-fallout")).toContain("/home/t/.wine-fallout/drive_c");
    expect(scanRoots(new MemoryPlatform({ os: "windows" }))).toEqual(["C:\\", "D:\\"]);
  });

  it("finds an install at a known location under the home directory", async () => {
    const platform = new MemoryPlatform({ home: "/home/t", files: install("/home/t/GOG Games/Fallout 2", "upu.dat") });
    expect(await scanForInstalls(platform, [])).toEqual([{ path: "/home/t/GOG Games/Fallout 2", type: "fallout2upu" }]);
  });

  it("finds an install inside the Wine prefix, which is where a Windows build lives", async () => {
    const platform = new MemoryPlatform({
      home: "/home/t",
      files: install("/home/t/.wine/drive_c/Program Files (x86)/Steam/steamapps/common/Fallout 2"),
    });
    const found = await scanForInstalls(platform, []);
    expect(found.map((one) => one.path)).toEqual([
      "/home/t/.wine/drive_c/Program Files (x86)/Steam/steamapps/common/Fallout 2",
    ]);
  });

  it("matches a lowercased directory name, which a Wine drive may hold instead", async () => {
    const platform = new MemoryPlatform({ home: "/home/t", files: install("/home/t/.wine/drive_c/games/fallout 2") });
    expect((await scanForInstalls(platform, [])).map((one) => one.path)).toEqual([
      "/home/t/.wine/drive_c/games/fallout 2",
    ]);
  });

  it("leaves out an install already on the list, so scanning twice adds nothing", async () => {
    const platform = new MemoryPlatform({ home: "/home/t", files: install("/home/t/Games/Fallout 2") });
    const known = [{ path: "/home/t/Games/Fallout 2", type: "fallout2" as const }];
    expect(await scanForInstalls(platform, known)).toEqual([]);
  });

  it("finds nothing on a machine with nothing to find, without failing on absent directories", async () => {
    expect(await scanForInstalls(new MemoryPlatform({ home: "/home/t" }), [])).toEqual([]);
  });
});
