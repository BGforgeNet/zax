import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { createDebugPackage, listSaves, saveDirectory } from "./debug-package.js";
import type { Install } from "@zax/core";

const INSTALL: Install = { path: "/games/one", type: "fallout2upu" };
const AT = new Date(2026, 7, 5, 18, 30, 0);
const ARCHIVE = "/home/t/.cache/zax/debug/zax_debug_2026-08-05_18-30-00.zip";

function installed(files: Record<string, string> = {}) {
  return new MemoryPlatform({
    home: "/home/t",
    files: {
      "/games/one/fallout2.exe": "MZ",
      "/games/one/fallout2.cfg": "[sound]",
      "/games/one/f2_res.ini": "[MAIN]",
      "/games/one/ddraw.dll": "sfall",
      "/games/one/debug.log": "crashed",
      "/games/one/master.dat": "big",
      ...files,
    },
  });
}

const packaged = async (platform: MemoryPlatform, saves: string[] = []) =>
  [...(await createDebugPackage(platform, INSTALL, saves, AT)).contents].sort();

describe("choosing what to attach", () => {
  it("finds the save directory whichever way the installer spelled it", async () => {
    const upper = installed({ "/games/one/data/SAVEGAME/SLOT01/SAVE.DAT": "" });
    const lower = installed({ "/games/one/data/savegame/SLOT01/SAVE.DAT": "" });
    expect(await saveDirectory(upper, INSTALL)).toBe("/games/one/data/SAVEGAME");
    expect(await saveDirectory(lower, INSTALL)).toBe("/games/one/data/savegame");
  });

  it("offers the numbered slots in order, and nothing else in the directory", async () => {
    const platform = installed({
      "/games/one/data/SAVEGAME/SLOT02/SAVE.DAT": "",
      "/games/one/data/SAVEGAME/SLOT01/SAVE.DAT": "",
      "/games/one/data/SAVEGAME/AUTOMAP.DB": "",
    });
    expect(await listSaves(platform, INSTALL)).toEqual(["SLOT01", "SLOT02"]);
  });

  it("offers nothing for an install that has never been played", async () => {
    expect(await listSaves(installed(), INSTALL)).toEqual([]);
  });
});

describe("creating the package", () => {
  it("collects the configs, the library and the logs, and leaves the game data out", async () => {
    const contents = await packaged(installed({ "/games/one/sfall-log.txt": "log" }));
    expect(contents).toEqual([
      "ddraw.dll",
      "debug.log",
      "f2_res.ini",
      "fallout2.cfg",
      "game.txt",
      "sfall-log.txt",
    ]);
  });

  it("writes the archive under the debug directory, named for when it was made", async () => {
    const platform = installed();
    expect((await createDebugPackage(platform, INSTALL, [], AT)).path).toBe(ARCHIVE);
    expect(platform.zipped).toHaveLength(1);
  });

  it("lists the game folder, which is the question the configs cannot answer", async () => {
    const platform = installed();
    await createDebugPackage(platform, INSTALL, [], AT);
    expect(platform.zipped[0]?.contents["game.txt"]).toBe(
      ["ddraw.dll", "debug.log", "f2_res.ini", "fallout2.cfg", "fallout2.exe", "master.dat"].join("\n"),
    );
  });

  it("takes the mod settings and a listing of the mods, when there are mods", async () => {
    const contents = await packaged(
      installed({ "/games/one/mods/sfall-mods.ini": "[mods]", "/games/one/mods/upu.dat": "" }),
    );
    expect(contents).toContain("mods/sfall-mods.ini");
    expect(contents).toContain("mods.txt");
    expect(contents).not.toContain("mods/upu.dat");
  });

  it("leaves out the mods listing entirely when the install has no mods directory", async () => {
    expect(await packaged(installed())).not.toContain("mods.txt");
  });

  it("attaches the saves that were chosen, whole, and no others", async () => {
    const platform = installed({
      "/games/one/data/SAVEGAME/SLOT01/SAVE.DAT": "one",
      "/games/one/data/SAVEGAME/SLOT01/AUTOMAP.SAV": "map",
      "/games/one/data/SAVEGAME/SLOT02/SAVE.DAT": "two",
    });
    const contents = await packaged(platform, ["SLOT01"]);
    expect(contents).toContain("SLOT01/SAVE.DAT");
    expect(contents).toContain("SLOT01/AUTOMAP.SAV");
    expect(contents.some((name) => name.startsWith("SLOT02"))).toBe(false);
  });

  it("clears the scratch files it wrote for the listings", async () => {
    const platform = installed();
    await createDebugPackage(platform, INSTALL, [], AT);
    expect(platform.allFiles().some((path) => path.includes("/tmp/debug-"))).toBe(false);
  });
});
