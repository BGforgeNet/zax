import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { copyTree, listFilesRecursively } from "./fs.js";

describe("walking a directory", () => {
  it("returns every file underneath it, as paths relative to it", async () => {
    const platform = new MemoryPlatform({
      files: { "/src/ddraw.dll": "MZ", "/src/mods/sfall-mods.ini": "[a]", "/src/translations/french.ini": "[b]" },
    });
    expect((await listFilesRecursively(platform, "/src")).toSorted()).toEqual([
      "ddraw.dll",
      "mods/sfall-mods.ini",
      "translations/french.ini",
    ]);
  });

  it("yields nothing for a directory that is not there, which callers ask about routinely", async () => {
    expect(await listFilesRecursively(new MemoryPlatform(), "/games/one/mods")).toEqual([]);
  });
});

describe("copying a tree", () => {
  it("puts every file at the same relative place under the destination", async () => {
    const platform = new MemoryPlatform({ files: { "/src/ddraw.dll": "new", "/src/mods/one.ini": "[a]" } });
    expect((await copyTree(platform, "/src", "/games/one")).toSorted()).toEqual(["ddraw.dll", "mods/one.ini"]);
    expect(platform.textAt("/games/one/ddraw.dll")).toBe("new");
    expect(platform.textAt("/games/one/mods/one.ini")).toBe("[a]");
  });

  it("overwrites what is already there, which is what replacing an installed component means", async () => {
    const platform = new MemoryPlatform({ files: { "/src/ddraw.dll": "new", "/games/one/ddraw.dll": "old" } });
    await copyTree(platform, "/src", "/games/one");
    expect(platform.textAt("/games/one/ddraw.dll")).toBe("new");
  });

  it("leaves files the source does not have alone", async () => {
    const platform = new MemoryPlatform({ files: { "/src/ddraw.dll": "new", "/games/one/fallout2.exe": "keep" } });
    await copyTree(platform, "/src", "/games/one");
    expect(platform.textAt("/games/one/fallout2.exe")).toBe("keep");
  });
});
