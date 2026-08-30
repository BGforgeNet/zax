import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { installKey, loadRecord, modName, reconcileRecord, saveRecord, type InstalledMod } from "./records.js";

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

  it("round-trips the bases a linked setting's addresses were last written with", async () => {
    const platform = new MemoryPlatform();
    const written = { "ddraw.ini|Interface|ExpandBarter": "1", "fallout2.cfg|ui|expand_barter_window": "1" };
    await saveRecord(platform, { path: GAME, mods: [], written });
    expect((await loadRecord(platform, GAME)).written).toEqual(written);
  });

  it("keeps a record that holds nothing but bases, which is an install ZAX has only configured", async () => {
    // The "an empty record is no record" rule deletes the file; a base is content, so it must count.
    const platform = new MemoryPlatform();
    await saveRecord(platform, { path: GAME, mods: [], written: { "ddraw.ini|Misc|DamageFormula": "5" } });
    expect((await loadRecord(platform, GAME)).written).toEqual({ "ddraw.ini|Misc|DamageFormula": "5" });
  });

  it("drops a malformed base rather than refusing the record it sits in", async () => {
    // A lost base costs the preference between two values; a refused record costs knowing what is installed.
    const platform = new MemoryPlatform();
    await saveRecord(platform, { path: GAME, mods: [mod()], written: { "a|b|c": "keep" } });
    const at = platform.paths.join(platform.paths.config, "installed-mods", `${installKey(GAME)}.yml`);
    const body = new TextDecoder().decode(await platform.fs.read(at));
    // A key that is not an address, and a value that is not text - both written by something that is not this.
    await platform.fs.write(at, new TextEncoder().encode(body.replace("written:", "written:\n  loose: 1\n  x|y: z")));

    const loaded = await loadRecord(platform, GAME);

    expect(loaded.written).toEqual({ "a|b|c": "keep" });
    expect(loaded.mods, "the rest of the record survived it").toHaveLength(1);
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

/**
 * A base mod is recorded with no file list at all - its installer decides what lands - so the file test above
 * can never find one missing. What answers for it is the type the directory reads as now.
 */
describe("reconciling a base mod, which records no files", () => {
  /** As `applyBaseInstall` writes one. */
  const upu = (over: Partial<InstalledMod> = {}): InstalledMod => ({
    id: "upu",
    version: "34",
    type: "base",
    complete: true,
    files: [],
    manifest:
      "spec: 1\nid: upu\nname: Unofficial Patch Updated\ngame: fallout2\ntype: base\nbecomes: fallout2upu\n" +
      // Named because a base mod carries an installer or a `creates`, and one without either is refused.
      "installer:\n  other:\n    asset: upu_v34.zip\n    run: upu-install.sh\n",
    shipped: {},
    ...over,
  });

  /** What `detectGameType` reads: the marker every install has, and the dat that names UPU. */
  const vanilla = { [`${GAME}/fallout2.exe`]: "MZ" };
  const patched = { ...vanilla, [`${GAME}/mods/upu.dat`]: "dat" };

  it("drops it once the folder has gone back to vanilla - a reset behind ZAX's back", async () => {
    const platform = new MemoryPlatform({ files: vanilla });
    await saveRecord(platform, { path: GAME, mods: [upu()] });
    expect((await reconcileRecord(platform, await loadRecord(platform, GAME))).mods).toEqual([]);
    // Pruned on disk as well, so the row and the game list agree on the next load too.
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });

  it("keeps it while the folder still reads as what the mod makes", async () => {
    const platform = new MemoryPlatform({ files: patched });
    await saveRecord(platform, { path: GAME, mods: [upu()] });
    expect((await reconcileRecord(platform, await loadRecord(platform, GAME))).mods).toHaveLength(1);
  });

  it("keeps an unfinished one, which is the retry the next launch offers", async () => {
    const platform = new MemoryPlatform({ files: vanilla });
    await saveRecord(platform, { path: GAME, mods: [upu({ complete: false })] });
    expect((await reconcileRecord(platform, await loadRecord(platform, GAME))).mods).toHaveLength(1);
  });

  it("keeps it where the folder no longer reads as an install at all", async () => {
    // The installation itself is gone or unreadable, which says nothing about this mod having been removed.
    const platform = new MemoryPlatform({ dirs: [GAME] });
    await saveRecord(platform, { path: GAME, mods: [upu()] });
    expect((await reconcileRecord(platform, await loadRecord(platform, GAME))).mods).toHaveLength(1);
  });

  it("keeps one whose manifest snapshot will not parse, having nothing to test it against", async () => {
    const platform = new MemoryPlatform({ files: vanilla });
    await saveRecord(platform, { path: GAME, mods: [upu({ manifest: "spec: 99\n" })] });
    expect((await reconcileRecord(platform, await loadRecord(platform, GAME))).mods).toHaveLength(1);
  });

  /** Fallout et tu: a base mod whose install is a folder inside this one, so this one stays vanilla. */
  const etTu = (over: Partial<InstalledMod> = {}): InstalledMod => ({
    id: "fo1in2",
    version: "1.16.3771",
    type: "base",
    complete: true,
    files: [],
    manifest:
      "spec: 1\nid: fo1in2\nname: Fallout et tu\ngame: fallout2\ntype: base\nbecomes: fo1in2\n" +
      "archive: Fallout1in2.zip\ncreates:\n  directory: Fallout1in2\n",
    shipped: {},
    ...over,
  });

  it("judges one that makes its own install by that directory rather than by this one", async () => {
    const platform = new MemoryPlatform({ files: { ...vanilla, [`${GAME}/Fallout1in2/fallout2.exe`]: "MZ" } });
    await saveRecord(platform, { path: GAME, mods: [etTu()] });
    expect((await reconcileRecord(platform, await loadRecord(platform, GAME))).mods).toHaveLength(1);
  });

  it("drops one whose created install the user deleted by hand", async () => {
    const platform = new MemoryPlatform({ files: vanilla });
    await saveRecord(platform, { path: GAME, mods: [etTu()] });
    expect((await reconcileRecord(platform, await loadRecord(platform, GAME))).mods).toEqual([]);
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
    // This was `parts` until this version learned to read those, which is the point: the stand-in has to be
    // genuinely unknown.
    await saveRecord(platform, { path: GAME, mods: [mod({ carried: { provenance: "manual" } })] });
    const loaded = await loadRecord(platform, GAME);
    expect(loaded.mods[0]?.carried).toEqual({ provenance: "manual" });
    await saveRecord(platform, loaded);
    expect((await loadRecord(platform, GAME)).mods[0]?.carried).toEqual({ provenance: "manual" });
  });
});

describe("engines in the record", () => {
  it("round-trips an engine beside the mods", async () => {
    const platform = new MemoryPlatform({ config: "cfg", cache: "cache" });
    await saveRecord(platform, {
      path: "/games/one",
      mods: [],
      engines: [
        {
          id: "fallout2-ce",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: ["fallout2-ce", "ce.dat"],
          backup: "2026-08-23_10-45-00",
          commit: "5f737d8fff969c90ddc86b0235afbce044c79b2d",
        },
      ],
    });
    const read = await loadRecord(platform, "/games/one");
    expect(read.engines).toEqual([
      {
        id: "fallout2-ce",
        release: "continious",
        published: "2026-08-23T09:37:22Z",
        complete: true,
        files: ["fallout2-ce", "ce.dat"],
        backup: "2026-08-23_10-45-00",
        commit: "5f737d8fff969c90ddc86b0235afbce044c79b2d",
      },
    ]);
  });

  it("round-trips the pin, which says the user picked this build rather than took the newest", async () => {
    const platform = new MemoryPlatform({ config: "cfg", cache: "cache" });
    await saveRecord(platform, {
      path: "/games/one",
      mods: [],
      engines: [
        {
          id: "fallout2-ce",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: ["fallout2-ce"],
          pinned: true,
        },
      ],
    });
    expect((await loadRecord(platform, "/games/one")).engines?.[0]?.pinned).toBe(true);
  });

  // Absent rather than false: a folder that follows the newest build is the common case, and an entry saying
  // so in a field would be one more thing every older record is read as having lied about.
  it("leaves the pin off an entry that does not carry one", async () => {
    const platform = new MemoryPlatform({ config: "cfg", cache: "cache" });
    await saveRecord(platform, {
      path: "/games/one",
      mods: [],
      engines: [
        {
          id: "fallout2-ce",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: ["fallout2-ce"],
        },
      ],
    });
    expect((await loadRecord(platform, "/games/one")).engines?.[0]).not.toHaveProperty("pinned");
  });

  it("drops an engine entry whose files reach outside the install, the way a tampered mod entry is dropped", async () => {
    const platform = new MemoryPlatform({ config: "cfg", cache: "cache" });
    await saveRecord(platform, {
      path: "/games/one",
      mods: [],
      engines: [
        {
          id: "fallout2-ce",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: ["../elsewhere"],
        },
      ],
    });
    expect((await loadRecord(platform, "/games/one")).engines ?? []).toEqual([]);
  });

  it("keeps the file for an install that has an engine and no mods", async () => {
    const platform = new MemoryPlatform({ config: "cfg", cache: "cache" });
    await saveRecord(platform, {
      path: "/games/one",
      mods: [],
      engines: [
        {
          id: "fallout2-ce",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: ["ce.dat"],
        },
      ],
    });
    expect((await loadRecord(platform, "/games/one")).engines).toHaveLength(1);
  });

  it("drops an engine whose files are all gone", async () => {
    const platform = new MemoryPlatform({ config: "cfg", cache: "cache", dirs: ["/games/one"] });
    await saveRecord(platform, {
      path: "/games/one",
      mods: [],
      engines: [
        {
          id: "fallout2-ce",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: ["fallout2-ce"],
        },
      ],
    });
    const reconciled = await reconcileRecord(platform, await loadRecord(platform, "/games/one"));
    expect(reconciled.engines ?? []).toEqual([]);
  });

  it("keeps one whose files are still there", async () => {
    const platform = new MemoryPlatform({
      config: "cfg",
      cache: "cache",
      files: { "/games/one/fallout2-ce": "binary" },
    });
    await saveRecord(platform, {
      path: "/games/one",
      mods: [],
      engines: [
        {
          id: "fallout2-ce",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: ["fallout2-ce"],
        },
      ],
    });
    const reconciled = await reconcileRecord(platform, await loadRecord(platform, "/games/one"));
    expect(reconciled.engines).toHaveLength(1);
  });
});
