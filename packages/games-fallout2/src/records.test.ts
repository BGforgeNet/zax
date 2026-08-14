import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { loadRecord, reconcileRecord, saveRecord, type InstalledMod } from "./records.js";

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
