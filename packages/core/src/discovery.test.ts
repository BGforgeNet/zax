import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { GOG_REGISTRY_KEYS, STEAM_REGISTRY_KEY } from "./install.js";
import { identifyInstall, scanForInstalls, scanRoots } from "./discovery.js";

/** A directory holding what makes it an install of one type. Marker files are empty; only presence is read. */
function install(root: string, marker?: "rpu.dat" | "upu.dat"): Record<string, string> {
  return { [`${root}/fallout2.exe`]: "MZ", ...(marker ? { [`${root}/mods/${marker}`]: "" } : {}) };
}

/** The clock is an argument to the scan, so the lines it logs are the same on every run. */
const AT = new Date("2026-01-01T00:00:00.000Z");

const scan = (platform: MemoryPlatform, known: Parameters<typeof scanForInstalls>[1] = []) =>
  scanForInstalls(platform, known, AT);

const paths = async (platform: MemoryPlatform) => (await scan(platform)).map((one) => one.path);

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

describe("where a scan starts", () => {
  it("looks under the home directory and the Wine drive", async () => {
    const posix = new MemoryPlatform({ home: "/home/t" });
    expect(await scanRoots(posix)).toEqual(["/home/t", "/home/t/.wine/drive_c"]);
    expect(await scanRoots(posix, "/home/t/.wine-fallout")).toContain("/home/t/.wine-fallout/drive_c");
  });

  it("takes mounted volumes as roots, which is where a Steam Deck keeps its card", async () => {
    const platform = new MemoryPlatform({ home: "/home/t", dirs: ["/run/media/deck/SD/steamapps"] });
    const roots = await scanRoots(platform);
    expect(roots).toContain("/run/media/deck/SD");
  });

  it("takes every drive that answers on Windows, not an assumed two", async () => {
    const platform = new MemoryPlatform({ os: "windows", dirs: ["C:/Windows", "D:/Games", "Q:/Archive"] });
    expect(await scanRoots(platform)).toEqual(["C:/", "D:/", "Q:/"]);
  });
});

describe("scanning the known locations", () => {
  it("finds an install at a known location under the home directory", async () => {
    const platform = new MemoryPlatform({ home: "/home/t", files: install("/home/t/GOG Games/Fallout 2", "upu.dat") });
    expect(await scan(platform)).toEqual([{ path: "/home/t/GOG Games/Fallout 2", type: "fallout2upu" }]);
  });

  it("finds an install inside the Wine prefix, which is where a Windows build lives", async () => {
    const platform = new MemoryPlatform({
      home: "/home/t",
      files: install("/home/t/.wine/drive_c/Program Files (x86)/Steam/steamapps/common/Fallout 2"),
    });
    expect(await paths(platform)).toEqual([
      "/home/t/.wine/drive_c/Program Files (x86)/Steam/steamapps/common/Fallout 2",
    ]);
  });

  it("finds a GOG Galaxy install, which does not share the offline installer's directory", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      files: install("C:/Program Files (x86)/GOG Galaxy/Games/Fallout 2"),
    });
    expect(await paths(platform)).toEqual(["C:/Program Files (x86)/GOG Galaxy/Games/Fallout 2"]);
  });

  it("finds an Xbox app install once it has been moved somewhere writable", async () => {
    const platform = new MemoryPlatform({ os: "windows", files: install("C:/XboxGames/Fallout 2/Content") });
    expect(await paths(platform)).toEqual(["C:/XboxGames/Fallout 2/Content"]);
  });

  it("matches a directory whatever its casing, and reports it only once", async () => {
    const platform = new MemoryPlatform({ os: "windows", files: install("C:/gog games/fallout 2") });
    expect(await paths(platform)).toEqual(["C:/gog games/fallout 2"]);
  });

  it("leaves out an install already on the list, so scanning twice adds nothing", async () => {
    const platform = new MemoryPlatform({ home: "/home/t", files: install("/home/t/Games/Fallout 2") });
    const known = [{ path: "/home/t/Games/Fallout 2", type: "fallout2" as const }];
    expect(await scan(platform, known)).toEqual([]);
  });

  it("leaves out a known install spelled with different casing on a filesystem that ignores it", async () => {
    const platform = new MemoryPlatform({ os: "windows", files: install("C:/GOG Games/Fallout 2") });
    const known = [{ path: "c:/gog games/fallout 2", type: "fallout2" as const }];
    expect(await scan(platform, known)).toEqual([]);
  });

  it("finds nothing on a machine with nothing to find, without failing on absent directories", async () => {
    expect(await scan(new MemoryPlatform({ home: "/home/t" }))).toEqual([]);
  });
});

describe("asking Steam where its libraries are", () => {
  /** A library list and a game manifest, in the format Steam writes them. */
  function steam(libraries: readonly string[], folder: string, at: string): Record<string, string> {
    const entries = libraries.map((path, index) => `"${index}" { "path" "${path}" }`).join("\n");
    return {
      "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf": `"libraryfolders" {\n${entries}\n}`,
      [`${at}/steamapps/appmanifest_38410.acf`]: `"AppState" { "appid" "38410" "installdir" "${folder}" }`,
    };
  }

  it("finds a library on another drive, which no list of default paths would name", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      files: {
        ...steam(["C:/Program Files (x86)/Steam", "D:/Odd Place"], "Fallout 2", "D:/Odd Place"),
        ...install("D:/Odd Place/steamapps/common/Fallout 2"),
      },
    });
    expect(await paths(platform)).toEqual(["D:/Odd Place/steamapps/common/Fallout 2"]);
  });

  it("takes the folder name from the manifest rather than assuming it", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      files: {
        ...steam(["D:/Odd Place"], "Fallout 2 Classic", "D:/Odd Place"),
        ...install("D:/Odd Place/steamapps/common/Fallout 2 Classic"),
      },
    });
    expect(await paths(platform)).toEqual(["D:/Odd Place/steamapps/common/Fallout 2 Classic"]);
  });

  it("finds Steam where the registry says it is, not only under the default paths", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      registry: { [STEAM_REGISTRY_KEY.key]: { [STEAM_REGISTRY_KEY.value]: "E:/Valve/Steam" } },
      files: {
        "E:/Valve/Steam/steamapps/appmanifest_38410.acf": `"AppState" { "installdir" "Fallout 2" }`,
        ...install("E:/Valve/Steam/steamapps/common/Fallout 2"),
      },
    });
    expect(await paths(platform)).toEqual(["E:/Valve/Steam/steamapps/common/Fallout 2"]);
  });

  it("ignores a library whose manifest says the game is not installed there", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      files: {
        "C:/Program Files (x86)/Steam/steamapps/libraryfolders.vdf": `"libraryfolders" { "0" { "path" "D:/Odd Place" } }`,
        ...install("D:/Odd Place/steamapps/common/Fallout 2"),
      },
    });
    expect(await paths(platform)).toEqual([]);
  });
});

describe("reading Epic's manifests", () => {
  it("takes the directory out of the manifest, so the folder name never has to be guessed", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      files: {
        "C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests/9f1.item": JSON.stringify({
          InstallLocation: "D:/Epic/FalloutClassic",
          DisplayName: "Fallout 2",
        }),
        ...install("D:/Epic/FalloutClassic"),
      },
    });
    expect(await paths(platform)).toEqual(["D:/Epic/FalloutClassic"]);
  });

  it("offers every manifest and lets the gate reject the ones that are other games", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      files: {
        "C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests/a.item": JSON.stringify({
          InstallLocation: "D:/Epic/Something Else",
        }),
        "C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests/b.item": JSON.stringify({
          InstallLocation: "D:/Epic/Fallout 2",
        }),
        "D:/Epic/Something Else/other.exe": "",
        ...install("D:/Epic/Fallout 2"),
      },
    });
    expect(await paths(platform)).toEqual(["D:/Epic/Fallout 2"]);
  });

  it("loses only the install a damaged manifest describes, not the scan", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      files: {
        "C:/ProgramData/Epic/EpicGamesLauncher/Data/Manifests/a.item": "{ this is not json",
        ...install("C:/GOG Games/Fallout 2"),
      },
    });
    expect(await paths(platform)).toEqual(["C:/GOG Games/Fallout 2"]);
  });
});

describe("asking the registry where GOG put things", () => {
  it("finds an install nothing else would reach", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      registry: { [GOG_REGISTRY_KEYS[0]!]: { path: "E:/Somewhere Odd/Fallout 2" } },
      files: install("E:/Somewhere Odd/Fallout 2", "rpu.dat"),
    });
    expect(await scan(platform)).toEqual([{ path: "E:/Somewhere Odd/Fallout 2", type: "fallout2rpu" }]);
  });

  it("tries the second product id, since which one an install registers under varies", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      registry: { [GOG_REGISTRY_KEYS[1]!]: { path: "E:/Games/F2" } },
      files: install("E:/Games/F2"),
    });
    expect(await paths(platform)).toEqual(["E:/Games/F2"]);
  });
});

describe("searching below the roots", () => {
  it("finds a folder nobody would have predicted the name of", async () => {
    const platform = new MemoryPlatform({ os: "windows", files: install("C:/Games/Fallout 2 with RPU") });
    expect(await paths(platform)).toEqual(["C:/Games/Fallout 2 with RPU"]);
  });

  it("does not go deeper than two levels below a root", async () => {
    const platform = new MemoryPlatform({ os: "windows", files: install("C:/a/b/c/Fallout 2") });
    expect(await paths(platform)).toEqual([]);
  });

  it("skips the directories a search has no business walking", async () => {
    const platform = new MemoryPlatform({ os: "windows", files: install("C:/Windows/Fallout 2") });
    expect(await paths(platform)).toEqual([]);
  });
});

describe("what a scan records", () => {
  it("logs the roots, the candidates and each install with the source that proposed it", async () => {
    const platform = new MemoryPlatform({ home: "/home/t", files: install("/home/t/GOG Games/Fallout 2") });
    await scan(platform);
    const log = platform.textAt("/home/t/.cache/zax/zax.log") ?? "";
    expect(log).toContain("scan: 2 roots");
    expect(log).toContain("/home/t/GOG Games/Fallout 2 (known location, fallout2)");
    expect(log).toContain(AT.toISOString());
  });

  it("says so when a directory could not be read, rather than reporting nothing there", async () => {
    const platform = new MemoryPlatform({ home: "/home/t", dirs: ["/home/t"] });
    // The Xbox app's directory is the one that does this on a real machine; any refusal reads the same way.
    const refusing = {
      ...platform,
      fs: {
        ...platform.fs,
        list: async (path: string) => {
          if (path === "/home/t") throw new Error("permission denied");
          return platform.fs.list(path);
        },
      },
    };
    await scanForInstalls(refusing, [], AT);
    expect(platform.textAt("/home/t/.cache/zax/zax.log") ?? "").toContain("could not look inside /home/t");
  });
});
