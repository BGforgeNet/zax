import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import type { FileStat, Platform } from "@zax/platform";
import { caseSensitiveAt, lowercaseTree, mixedCasePaths } from "./case-lowering.js";

const GAME = "/game";

const gamePlatform = (files: Record<string, string>) =>
  new MemoryPlatform({ files: { [`${GAME}/fallout2.exe`]: "", ...files } });

/**
 * The same platform on a filesystem that folds case, which is what macOS and Windows do: a path resolves
 * whatever case it is asked for. Written as a wrapper because the in-memory platform is case-sensitive, and
 * the pass's first question is which of the two it is talking to.
 */
const folding = (platform: MemoryPlatform): Platform => ({
  os: platform.os,
  arch: platform.arch,
  fs: {
    ...platform.fs,
    stat: async (path: string): Promise<FileStat | null> => {
      const direct = await platform.fs.stat(path);
      if (direct) return direct;
      for (const candidate of [path.toLowerCase(), path.toUpperCase()]) {
        const found = await platform.fs.stat(candidate);
        if (found) return found;
      }
      return null;
    },
  },
  paths: platform.paths,
  process: platform.process,
  net: platform.net,
  registry: platform.registry,
  hash: platform.hash,
  archive: platform.archive,
});

describe("telling which kind of filesystem this is", () => {
  it("reads a case-sensitive one by asking for a name that differs only in case", async () => {
    // Read-only rather than the `touch fs_testx fs_testX` the shell installer does: the answer is the same
    // and nothing is written into somebody's game directory to get it.
    const platform = gamePlatform({});
    expect(await caseSensitiveAt(platform, GAME)).toBe(true);
  });

  it("reads a folding one as what it is", async () => {
    const platform = gamePlatform({});
    expect(await caseSensitiveAt(folding(platform), GAME)).toBe(false);
  });

  it("answers false where there is nothing to ask about, rather than guessing", async () => {
    // An empty directory tells you nothing, and a pass that renames nothing is the same outcome either way.
    expect(await caseSensitiveAt(new MemoryPlatform({ dirs: [GAME] }), GAME)).toBe(false);
  });
});

describe("what the pass would rename", () => {
  it("names every entry that is not already lowercase, deepest first", async () => {
    const platform = gamePlatform({
      [`${GAME}/Master.dat`]: "DAT",
      [`${GAME}/data/Scripts/GL_Ammo.int`]: "INT",
      [`${GAME}/mods/rpu.dat`]: "DAT",
    });
    // Deepest first, so a directory is renamed only once nothing under it still needs to be found.
    expect(await mixedCasePaths(platform, GAME)).toEqual(["data/Scripts/GL_Ammo.int", "data/Scripts", "Master.dat"]);
  });

  it("leaves the backup directory alone, which is where the way back lives", async () => {
    const platform = gamePlatform({ [`${GAME}/backup/rpu/Data/Patch000.dat`]: "DAT" });
    expect(await mixedCasePaths(platform, GAME)).toEqual([]);
  });

  it("leaves a .git alone wherever it sits, not only at the top", async () => {
    // A game folder somebody keeps under version control, and one where a mod was unpacked from a clone: the
    // exclusion is the directory, not the depth it was found at.
    const platform = gamePlatform({
      [`${GAME}/.git/HEAD`]: "ref: refs/heads/main",
      [`${GAME}/.git/refs/heads/Fixes`]: "SHA",
      [`${GAME}/mods/rpu/.git/ORIG_HEAD`]: "SHA",
    });
    expect(await mixedCasePaths(platform, GAME)).toEqual([]);
  });

  it("refuses the whole pass when two entries differ only by case", async () => {
    // Legal on a case-sensitive filesystem and impossible afterwards: renaming one onto the other loses it.
    const platform = gamePlatform({ [`${GAME}/mods/Rpu.dat`]: "ONE", [`${GAME}/mods/rpu.dat`]: "TWO" });
    // Both named, in whichever order the listing gives them - the pair is the message's whole point.
    await expect(mixedCasePaths(platform, GAME)).rejects.toThrow(/mods\/Rpu\.dat/);
    await expect(mixedCasePaths(platform, GAME)).rejects.toThrow(/mods\/rpu\.dat/);
  });
});

describe("lowercasing the tree", () => {
  it("renames every entry, contents and all, and says what it did", async () => {
    const platform = gamePlatform({
      [`${GAME}/Master.dat`]: "MASTER",
      [`${GAME}/data/Scripts/GL_Ammo.int`]: "INT",
    });
    const renamed = await lowercaseTree(platform, GAME);
    expect(renamed).toEqual(["data/Scripts/GL_Ammo.int", "data/Scripts", "Master.dat"]);
    expect(platform.textAt(`${GAME}/master.dat`)).toBe("MASTER");
    expect(platform.textAt(`${GAME}/data/scripts/gl_ammo.int`)).toBe("INT");
    expect(await platform.fs.stat(`${GAME}/Master.dat`)).toBeNull();
  });

  it("renames nothing at all when a collision would make the result ambiguous", async () => {
    const platform = gamePlatform({
      [`${GAME}/Rpu.dat`]: "ONE",
      [`${GAME}/rpu.dat`]: "TWO",
      [`${GAME}/Other.dat`]: "X",
    });
    await expect(lowercaseTree(platform, GAME)).rejects.toThrow(/Rpu\.dat/);
    // The unrelated entry is still where it was: the refusal is of the pass, not of one rename in it.
    expect(platform.textAt(`${GAME}/Other.dat`)).toBe("X");
  });

  it("renames around a repository rather than through it", async () => {
    // `HEAD` lowercased is a repository git cannot open, and the game reads none of these files anyway.
    const platform = gamePlatform({
      [`${GAME}/.git/HEAD`]: "ref: refs/heads/main",
      [`${GAME}/Master.dat`]: "MASTER",
    });
    expect(await lowercaseTree(platform, GAME)).toEqual(["Master.dat"]);
    expect(platform.textAt(`${GAME}/.git/HEAD`)).toBe("ref: refs/heads/main");
    expect(await platform.fs.stat(`${GAME}/.git/head`)).toBeNull();
  });

  it("does nothing to a tree that is already lowercase", async () => {
    const platform = gamePlatform({ [`${GAME}/master.dat`]: "DAT" });
    expect(await lowercaseTree(platform, GAME)).toEqual([]);
  });
});
