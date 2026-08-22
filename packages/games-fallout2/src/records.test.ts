import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { loadRecord, modName, reconcileRecord, saveRecord, type InstalledMod } from "./records.js";

const GAME = "/games/fallout2";

const mod = (over: Partial<InstalledMod> = {}): InstalledMod => ({
  id: "fo2tweaks",
  version: "14.7",
  complete: true,
  files: ["mods/fo2tweaks.dat", "mods/fo2tweaks.ini"],
  manifest: "spec: 1\nid: fo2tweaks\n",
  shipped: { "mods/fo2tweaks.ini": "[main]\r\nenabled=1\r\n" },
  ...over,
});

describe("modName", () => {
  it("takes the name the manifest snapshot carries", () => {
    const manifest = 'spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: "14.7"\ngame: fallout2\n';
    expect(modName(mod({ manifest }))).toBe("FO2tweaks");
  });

  it("falls back to the id when that snapshot will not parse", () => {
    expect(modName(mod({ manifest: "spec: 99\n" }))).toBe("fo2tweaks");
  });
});

describe("installed records", () => {
  it("answers empty for an install that has none - a first install and a lost record read the same", async () => {
    const platform = new MemoryPlatform();
    expect(await loadRecord(platform, GAME)).toEqual({ path: GAME, mods: [] });
  });

  it("round-trips a record, latin1 state text included", async () => {
    const platform = new MemoryPlatform();
    const shipped = { "mods/fo2tweaks.ini": "[main]\r\n; caf\xe9\r\nenabled=1\r\n" };
    await saveRecord(platform, { path: GAME, mods: [mod({ shipped })] });
    const loaded = await loadRecord(platform, GAME);
    expect(loaded.mods).toEqual([mod({ shipped })]);
  });

  it("lands two spellings of one directory on one record file", async () => {
    const platform = new MemoryPlatform();
    await saveRecord(platform, { path: `${GAME}/`, mods: [mod()] });
    expect((await loadRecord(platform, GAME)).mods).toHaveLength(1);
  });

  it("keeps records beside zax.yml, out of the wipeable cache", async () => {
    const platform = new MemoryPlatform();
    await saveRecord(platform, { path: GAME, mods: [mod()] });
    const files = platform.allFiles().filter((path) => path.includes("installed-mods"));
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(platform.paths.config);
    // The filename is a hash; the path in clear lives inside, for inspection.
    expect(platform.textAt(files[0]!)).toContain(`path: ${GAME}`);
  });

  it("removes the file when the last mod is gone - an empty record is no record", async () => {
    const platform = new MemoryPlatform();
    await saveRecord(platform, { path: GAME, mods: [mod()] });
    await saveRecord(platform, { path: GAME, mods: [] });
    expect(platform.allFiles().filter((path) => path.includes("installed-mods"))).toHaveLength(0);
  });

  it("drops an entry whose file list reaches outside mods/, degrading it to hand-installed", async () => {
    const platform = new MemoryPlatform();
    await saveRecord(platform, {
      path: GAME,
      mods: [mod(), mod({ id: "tampered", files: ["mods/../fallout2.exe"] })],
    });
    const loaded = await loadRecord(platform, GAME);
    expect(loaded.mods.map((entry) => entry.id)).toEqual(["fo2tweaks"]);
  });

  it("survives a record that will not parse, as a lost record rather than a crash", async () => {
    const platform = new MemoryPlatform();
    await saveRecord(platform, { path: GAME, mods: [mod()] });
    const file = platform.allFiles().find((path) => path.includes("installed-mods"))!;
    await platform.fs.write(file, new TextEncoder().encode("mods: [unclosed"));
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });
});

describe("record reconciliation", () => {
  it("drops a mod whose files are all gone from a directory that was read", async () => {
    const platform = new MemoryPlatform({ dirs: [GAME] });
    await saveRecord(platform, { path: GAME, mods: [mod()] });
    const reconciled = await reconcileRecord(platform, await loadRecord(platform, GAME));
    expect(reconciled.mods).toEqual([]);
    // Pruned on disk too, so the drop happens once rather than on every load.
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });

  it("keeps a mod while any recorded file remains", async () => {
    const platform = new MemoryPlatform({ files: { [`${GAME}/mods/fo2tweaks.ini`]: "[main]" } });
    await saveRecord(platform, { path: GAME, mods: [mod()] });
    const reconciled = await reconcileRecord(platform, await loadRecord(platform, GAME));
    expect(reconciled.mods).toHaveLength(1);
  });

  it("sets the record aside untouched when the directory cannot be read - a drive offline for a session", async () => {
    const platform = new MemoryPlatform();
    await saveRecord(platform, { path: GAME, mods: [mod()] });
    const reconciled = await reconcileRecord(platform, await loadRecord(platform, GAME));
    expect(reconciled.mods).toHaveLength(1);
  });
});

describe("a record a later ZAX wrote", () => {
  /** The same record with its format bumped past what this version writes - what a downgrade meets. */
  const laterOnDisk = async (platform: MemoryPlatform): Promise<string> => {
    await saveRecord(platform, { path: GAME, mods: [mod()] });
    const file = platform.allFiles().find((path) => path.includes("installed-mods"))!;
    const text = new TextDecoder().decode(await platform.fs.read(file));
    await platform.fs.write(file, new TextEncoder().encode(text.replace("record: 1", "record: 2")));
    return file;
  };

  it("is read, and refused a write back", async () => {
    const platform = new MemoryPlatform();
    const file = await laterOnDisk(platform);
    const before = new TextDecoder().decode(await platform.fs.read(file));

    const loaded = await loadRecord(platform, GAME);
    expect(loaded.laterFormat).toBe(2);
    expect(loaded.mods.map((entry) => entry.id)).toEqual(["fo2tweaks"]);

    await expect(saveRecord(platform, loaded)).rejects.toThrow(/newer version of ZAX/);
    // Untouched is the whole point: rewriting it from here would drop whatever that format added.
    expect(new TextDecoder().decode(await platform.fs.read(file))).toBe(before);
  });

  it("is not pruned by reconciliation either, however stale the directory looks", async () => {
    const platform = new MemoryPlatform({ dirs: [GAME] });
    await laterOnDisk(platform);
    // Every recorded file is gone, which for a record this version owns drops the entry and saves the drop.
    expect((await reconcileRecord(platform, await loadRecord(platform, GAME))).mods).toHaveLength(1);
  });

  it("keeps an entry this version cannot read rather than erasing it on the next write", async () => {
    const platform = new MemoryPlatform();
    await saveRecord(platform, {
      path: GAME,
      mods: [mod(), mod({ id: "granted", files: ["appearance/hero.dat"] })],
    });
    const loaded = await loadRecord(platform, GAME);
    expect(loaded.mods.map((entry) => entry.id)).toEqual(["fo2tweaks"]);
    expect(loaded.opaque?.map((entry) => entry.id)).toEqual(["granted"]);

    await saveRecord(platform, loaded);
    const again = await loadRecord(platform, GAME);
    expect(again.opaque).toEqual(loaded.opaque);
    expect(again.mods).toEqual(loaded.mods);
  });

  it("round-trips a part selection, and drops an entry whose selection could not have been minted", async () => {
    const platform = new MemoryPlatform();
    await saveRecord(platform, { path: GAME, mods: [mod({ parts: ["head", "voice-joey"] })] });
    expect((await loadRecord(platform, GAME)).mods[0]?.parts).toEqual(["head", "voice-joey"]);

    // The same bound the manifest puts on a part id, for the one route into this field that skipped it.
    await saveRecord(platform, { path: GAME, mods: [mod({ parts: ["../elsewhere"] })] });
    const loaded = await loadRecord(platform, GAME);
    expect(loaded.mods).toEqual([]);
    expect(loaded.opaque?.map((entry) => entry.id)).toEqual(["fo2tweaks"]);
  });

  it("carries a per-mod field it has no rule for through a rewrite", async () => {
    const platform = new MemoryPlatform();
    // A field this version has no rule for - a profile the mod was installed under, say. It was `parts`
    // until this version learned to read those, which is the point: the stand-in has to be genuinely unknown.
    await saveRecord(platform, { path: GAME, mods: [mod({ carried: { profile: "hardcore" } })] });
    const loaded = await loadRecord(platform, GAME);
    expect(loaded.mods[0]?.carried).toEqual({ profile: "hardcore" });
    await saveRecord(platform, loaded);
    expect((await loadRecord(platform, GAME)).mods[0]?.carried).toEqual({ profile: "hardcore" });
  });
});
