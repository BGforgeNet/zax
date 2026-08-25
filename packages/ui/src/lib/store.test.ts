import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ownTarget } from "@zax/core";
import { ENGINE_CONFIG_FILES, ENGINES, SETTINGS } from "@zax/fallout2";
import { PREVIEW_INSTALL, backend as hostBackend, previewPlatform } from "./host.js";
import { store, unwrapArguments } from "./store.svelte.js";
import {
  BACKEND_METHODS,
  loadRecord,
  saveRecord,
  type Backend,
  type ModFeedListing,
  type ModInstallState,
} from "@zax/fallout2";
import fallout2cfg from "../../../../fixtures/f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/f2up/ddraw.ini?raw";

/**
 * The store reads its state and the selected install's config files from the platform, and the tests below
 * write to both, so each starts from the seeded state file rather than from whatever the last test left.
 *
 * Without this the gate and conflict tests run against an empty baseline, where every value reads as absent -
 * and they pass, because "absent" is also what a closed gate looks like.
 */
const bytes = (text: string) => {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
};

const ADDED_INSTALL = "preview/added";
const ORDER_FILE = `${PREVIEW_INSTALL}/mods/mods_order.txt`;
const MOD_INI = `${PREVIEW_INSTALL}/mods/fo2tweaks.ini`;
/** Captured on the first run, before any test has written to it, so the seed is not repeated here to drift. */
let seededOrder: Uint8Array | null = null;
let seededModIni: Uint8Array | null = null;

beforeEach(async () => {
  const seeded = `games:\n- path: ${PREVIEW_INSTALL}\ntheme: system\n`;
  await previewPlatform.fs.write("preview/config/zax.yml", new TextEncoder().encode(seeded));
  // The config files too: a test that saves rewrites them, and the next test would inherit that.
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fallout2.cfg`, bytes(fallout2cfg));
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/f2_res.ini`, bytes(f2resini));
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(ddrawini));
  // And an engine's own config goes, so a test that writes one does not leave the next install looking like
  // one an engine has already run in. Reseeding fallout2.cfg clears fallout2-ce's mark with it.
  for (const name of ENGINE_CONFIG_FILES) await previewPlatform.fs.remove(`${PREVIEW_INSTALL}/${name}`);
  seededOrder ??= await previewPlatform.fs.read(ORDER_FILE);
  await previewPlatform.fs.write(ORDER_FILE, seededOrder);
  seededModIni ??= await previewPlatform.fs.read(MOD_INI);
  await previewPlatform.fs.write(MOD_INI, seededModIni);
  await store.start();
});

test("starts on the seeded install with its config files read", () => {
  expect(store.installs.map((one) => one.path)).toEqual([PREVIEW_INSTALL]);
  // Read from the fixture rather than defaulted: everything below distinguishes a value from its absence.
  expect(store.baselineOf("sfall.Misc.ProcessorIdle")).toBe("-1");
  expect(store.baselineOf("hires.OTHER_SETTINGS.CPU_USAGE_FIX")).toBe("0");
});

describe("a setting more than one engine carries", () => {
  const BARTER = "sfall.Interface.ExpandBarter";
  const read = async (name: string) =>
    new TextDecoder("latin1").decode(await previewPlatform.fs.read(`${PREVIEW_INSTALL}/${name}`));

  /** An install whose engines have each written their own settings, which is what makes their keys writable. */
  const withEngines = async () => {
    await previewPlatform.fs.write(
      `${PREVIEW_INSTALL}/fallout2.cfg`,
      bytes(`${fallout2cfg}\n[ui]\nextend_ap_bar=0\nexpand_barter_window=0\n`),
    );
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
    await store.start();
  };

  test("writes one edit to every engine that has run, under each of their own names", async () => {
    await withEngines();
    store.set(BARTER, "1");
    await store.save();

    expect(store.notice, "a save that worked has nothing to report").toBeNull();
    expect(await read("ddraw.ini")).toContain("ExpandBarter=1");
    expect(await read("fallout2.cfg")).toContain("expand_barter_window=1");
    expect(await read("fission.cfg")).toContain("EnhancedBarter=1");
  });

  test("leaves the keys of an engine that has never run alone", async () => {
    // Writing them early would create the section fallout2-ce's own one-shot import checks for, and the
    // import would then never run - the user would lose what it was meant to carry across, silently.
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
    await store.start();
    store.set(BARTER, "1");
    await store.save();

    expect(await read("ddraw.ini")).toContain("ExpandBarter=1");
    expect(await read("fission.cfg")).toContain("EnhancedBarter=1");
    // The seeded fixture is vanilla, so fallout2-ce has written nothing and neither does ZAX.
    expect(await read("fallout2.cfg")).not.toContain("expand_barter_window");
    expect(await read("fallout2.cfg")).not.toContain("[ui]");
  });

  test("carries a value changed inside an engine across to the rest, and says where it came from", async () => {
    // What the engine's own preferences screen leaves behind. ZAX wrote 0 everywhere, so the address that no
    // longer says 0 is the side that moved.
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await store.start();

    expect(store.valueOf(BARTER), "the newer value won").toBe("1");
    expect(store.isModified(BARTER), "left pending rather than written during a load").toBe(true);
    expect(store.propagated[BARTER], "the row has to be able to say where it came from").toBe("fission.cfg");
    expect(store.notice?.kind).toBe("note");
  });

  test("asks rather than choosing when two engines have both moved", async () => {
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(`${ddrawini}\n[Interface]\nExpandBarter=2\n`));
    await store.start();

    expect(store.propagated[BARTER], "no value was picked on the user's behalf").toBeUndefined();
    expect(store.settingsChoices.map((one) => one.id)).toContain(BARTER);
  });

  test("writes the same set from a one-click fix as from the row", async () => {
    // Both go through the same pending layer, so the action cannot reach a different set of files.
    await withEngines();
    store.applyAction({
      id: "test.barter",
      group: "fix",
      label: "Expand the barter window",
      description: "Four item slots per table instead of three.",
      appliedLabel: "Already expanded",
      targets: { [BARTER]: "1" },
    });
    await store.save();

    expect(await read("ddraw.ini")).toContain("ExpandBarter=1");
    expect(await read("fallout2.cfg")).toContain("expand_barter_window=1");
    expect(await read("fission.cfg")).toContain("EnhancedBarter=1");
  });
});

test("recognizes a linked setting under the engine's own key rather than inventing a second row", async () => {
  // What an install that has run fallout2-ce once looks like: the engine writes its own sections into the
  // game's config file, and the keys in them are ones the catalog already describes under other names.
  await previewPlatform.fs.write(
    `${PREVIEW_INSTALL}/fallout2.cfg`,
    bytes(`${fallout2cfg}\n[ui]\nexpand_barter_window=1\n`),
  );
  // And sfall's own side of the same link, which the bundled 3.3 ddraw.ini predates.
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(`${ddrawini}\n[Interface]\nExpandBarter=0\n`));
  await store.start();

  const ids = store.discovered.map((s) => s.id);
  expect(ids, "the engine's key read as an unknown one").not.toContain("raw.fallout2.cfg.ui.expand_barter_window");
  expect(
    ids.filter((id) => id === "sfall.Interface.ExpandBarter"),
    "one setting, however many of its addresses the file holds",
  ).toHaveLength(1);
});

describe("installs", () => {
  const seed = async () => {
    store.installs = [
      { path: "/games/a", type: "fallout2" },
      { path: "/games/b", type: "fallout2rpu" },
    ];
    await store.selectInstall("/games/a");
  };

  test("removing the selected install moves the selection rather than stranding it", async () => {
    await seed();
    await store.removeInstall("/games/a");
    // Every settings view reads the selected install, so leaving it pointing at a removed one would leave
    // them all bound to something no longer in the list.
    expect(store.selectedInstall).toBe("/games/b");
    expect(store.install?.path).toBe("/games/b");
  });

  test("removing an install that is not selected leaves the selection alone", async () => {
    await seed();
    await store.removeInstall("/games/b");
    expect(store.selectedInstall).toBe("/games/a");
  });

  test("removing the last install leaves nothing selected rather than a stale path", async () => {
    await seed();
    await store.removeInstall("/games/a");
    await store.removeInstall("/games/b");
    expect(store.selectedInstall).toBe("");
    expect(store.install).toBeUndefined();
  });

  test("wine settings attach to one install and survive a change to the other", async () => {
    await seed();
    await store.setWine("/games/a", { prefix: "/home/u/.wine-a" });
    await store.setWine("/games/b", { debug: "-all" });
    expect(store.installs.find((g) => g.path === "/games/a")?.wine).toEqual({ prefix: "/home/u/.wine-a" });
    expect(store.installs.find((g) => g.path === "/games/b")?.wine).toEqual({ debug: "-all" });
  });

  test("an install added by pointing at it starts with Wine silenced", async () => {
    await previewPlatform.fs.write(`${ADDED_INSTALL}/fallout2.exe`, new Uint8Array([0x4d, 0x5a]));
    await store.addInstall(ADDED_INSTALL);
    expect(store.installs.find((g) => g.path === ADDED_INSTALL)?.wine).toEqual({ debug: "-all" });
  });
});

describe("the debugging actions and Wine", () => {
  const enable = () => store.actionById("debug.enable")!;
  const disable = () => store.actionById("debug.disable")!;

  test("enabling debugging clears WINEDEBUG, and turning it off silences Wine again", async () => {
    await store.setWine(PREVIEW_INSTALL, { debug: "-all" });
    expect(store.actionApplied(enable()), "silenced Wine leaves the action still to do").toBe(false);

    store.applyAction(enable());
    await vi.waitFor(() => expect(store.install?.wine?.debug).toBeUndefined());
    expect(store.actionWineDebug).toBe("");

    store.applyAction(disable());
    await vi.waitFor(() => expect(store.install?.wine?.debug).toBe("-all"));
  });

  test("leaves a prefix the user set alone while changing the logging", async () => {
    await store.setWine(PREVIEW_INSTALL, { prefix: "/home/u/.wine-f2", debug: "-all" });
    store.applyAction(enable());
    await vi.waitFor(() => expect(store.install?.wine).toEqual({ prefix: "/home/u/.wine-f2" }));
  });
});

describe("search", () => {
  test("answers the same rows for one query, and different rows when it changes", () => {
    // The tab that draws these reads `results` once per row, so the getter holds its last answer. That is
    // only safe while a changed query still recomputes, which is what the second half checks.
    store.query = "worldmap";
    const first = store.results;
    expect(store.results, "the same query is not recomputed").toBe(first);

    store.query = "sound";
    expect(store.results).not.toBe(first);
    expect(
      store.results.every((r) => `${r.def.label} ${ownTarget(r.def).key} ${r.where}`.toLowerCase().includes("sound")),
    ).toBe(true);
    store.query = "";
  });

  test("reaches settings on tabs other than the one on screen", () => {
    store.settingsTab = "fallout2.cfg";
    store.query = "worldmap";
    // Every match here lives in ddraw.ini, which is a different tab from the one selected.
    const files = new Set(store.results.map((r) => ownTarget(r.def).file));
    expect(store.results.length).toBeGreaterThan(0);
    expect(files).toEqual(new Set(["ddraw.ini"]));
    store.query = "";
  });

  test("gives every result an address, since the row has left the tab that located it", () => {
    store.query = "mode";
    expect(store.results.length).toBeGreaterThan(1);
    for (const r of store.results) {
      expect(r.where, `${r.def.id} has no address`).not.toBe("");
      expect(r.where).toContain(r.place.tab);
    }
    // Several settings are now simply "Mode" - their frame says which - so the address is the only thing that
    // separates them once search has lifted them out of it.
    const modes = store.results.filter((r) => r.def.label === "Mode");
    expect(modes.length).toBeGreaterThan(2);
    expect(new Set(modes.map((r) => r.where)).size, "two results share one address").toBe(modes.length);
    store.query = "";
  });

  test("reaches the one tab that holds nothing from the catalog", () => {
    // The install tab's fields belong to the install, not to a config file, so they are not in SETTINGS at all
    // - and a search that silently omits a whole tab reads as a search that does not work.
    store.query = "wine";
    expect(store.results, "the install tab holds no catalog settings").toEqual([]);
    expect(store.installMatches).toBe(true);

    store.query = "wineprefix";
    expect(store.installMatches).toBe(true);

    store.query = "alias";
    expect(store.installMatches, "the alias lives there too, on every platform").toBe(true);

    store.query = "worldmap";
    expect(store.installMatches, "an unrelated query must not offer it").toBe(false);
    store.query = "";
  });

  test("does not offer a result the tab it lives on will not show", () => {
    // free_space is placed but hidden, so a result for it would carry a "go to" that lands nowhere.
    store.query = "free space";
    expect(store.results.map((r) => r.def.id)).not.toContain("game.system.free_space");

    // A pinned value is drawn even where the layout hides it, so it stays findable.
    store.query = "uac";
    expect(store.results.map((r) => r.def.id)).toContain("hires.MAIN.UAC_AWARE");
    store.query = "";
  });

  test("finds a setting by one of its choice option labels", () => {
    // "DirectX9" appears only as an option label of the graphics mode choice - its label, key and address say
    // nothing about DirectX - so this passes only while option labels are part of the searched text.
    store.query = "directx9";
    expect(store.results.map((r) => r.def.id)).toContain("hires.MAIN.GRAPHICS_MODE");
    store.query = "";
  });

  test("going to a result selects the tab it lives on and drops the query", () => {
    store.query = "worldmap";
    const first = store.results[0]!;
    store.goTo(first.place);
    expect(store.settingsTab).toBe(first.place.group);
    expect(store.fileTab[first.place.group]).toBe(first.place.tab);
    expect(store.query, "leaving the query would send the user straight back to the results").toBe("");
  });
});

describe("gates", () => {
  const def = (id: string) => SETTINGS.find((s) => s.id === id)!;

  test("a gate on a key binding opens only once a key is actually bound", () => {
    store.revertAll();
    // The fixture never writes the binding, so the gate starts closed on an absent value rather than on a
    // listed one - the case a values-list gate could not express at all.
    expect(store.gateOf(def("sfall.Input.FastMoveFromContainer"))?.active).toBe(false);

    store.set("sfall.Input.ItemFastMoveKey", "30");
    expect(store.gateOf(def("sfall.Input.FastMoveFromContainer"))?.active).toBe(true);

    store.set("sfall.Input.ItemFastMoveKey", "0");
    expect(store.gateOf(def("sfall.Input.FastMoveFromContainer"))?.active).toBe(false);
    store.revertAll();
  });

  test("the merged resolution keys carry the gate the pair control has to render", () => {
    store.revertAll();
    // The pair renders one control over two keys, so it reads the gate off a member rather than off itself.
    expect(store.gateOf(def("sfall.Graphics.GraphicsWidth"))?.active).toBe(false);
    store.set("sfall.Graphics.Mode", "4");
    expect(store.gateOf(def("sfall.Graphics.GraphicsWidth"))?.active).toBe(true);
    store.revertAll();
  });
});

describe("conflicts", () => {
  const fix = () => SETTINGS.find((s) => s.id === "hires.OTHER_SETTINGS.CPU_USAGE_FIX")!;

  test("stays quiet until both settings are in the states that clash", () => {
    store.revertAll();
    // The fixture ships both off: CPU_USAGE_FIX=0 and ProcessorIdle=-1.
    expect(store.conflictOf(fix())).toBeNull();

    store.set("hires.OTHER_SETTINGS.CPU_USAGE_FIX", "1");
    expect(store.conflictOf(fix()), "one side alone is not a clash").toBeNull();

    store.set("sfall.Misc.ProcessorIdle", "0");
    expect(store.conflictOf(fix())?.other.id).toBe("sfall.Misc.ProcessorIdle");

    // Backing either side out clears it again.
    store.set("sfall.Misc.ProcessorIdle", "-1");
    expect(store.conflictOf(fix())).toBeNull();
    store.revertAll();
  });

  test("warns on both halves, not only the one carrying the declaration", () => {
    store.revertAll();
    const idle = SETTINGS.find((s) => s.id === "sfall.Misc.ProcessorIdle")!;
    expect(idle.conflictsWith, "the declaration sits on the other half").toBeUndefined();

    store.set("hires.OTHER_SETTINGS.CPU_USAGE_FIX", "1");
    store.set("sfall.Misc.ProcessorIdle", "0");
    // Someone who reaches this setting first would otherwise flip it with no warning at all.
    expect(store.conflictOf(idle)?.other.id).toBe("hires.OTHER_SETTINGS.CPU_USAGE_FIX");
    store.revertAll();
    expect(store.conflictOf(idle)).toBeNull();
  });
});

describe("saving", () => {
  const MUSIC = "game.sound.music";

  test("writes the pending edits to the install's own files and clears them", async () => {
    const before = store.baselineOf(MUSIC);
    store.set(MUSIC, before === "1" ? "0" : "1");
    expect(store.isModified(MUSIC)).toBe(true);

    await store.save();

    expect(store.notice, "a save that worked has nothing to report").toBeNull();
    expect(store.isModified(MUSIC), "a saved edit is no longer pending").toBe(false);
    // Read back through a fresh start, which is the only proof the value reached the file.
    await store.start();
    expect(store.baselineOf(MUSIC)).toBe(before === "1" ? "0" : "1");
  });

  test("leaves every other line of the file exactly as it was", async () => {
    store.set(MUSIC, store.baselineOf(MUSIC) === "1" ? "0" : "1");
    await store.save();

    const written = new TextDecoder("latin1").decode(await previewPlatform.fs.read(`${PREVIEW_INSTALL}/fallout2.cfg`));
    const changed = written.split("\n").filter((line, at) => line !== fallout2cfg.split("\n")[at]);
    expect(changed, "a save must rewrite one line").toHaveLength(1);
    expect(changed[0]).toMatch(/^music=/);
  });

  test("refuses and writes nothing when the file changed underneath the open window", async () => {
    store.set(MUSIC, "0");
    // What a text editor open on the same file would do.
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fallout2.cfg`, bytes(`${fallout2cfg}\n; edited elsewhere\n`));

    await store.save();

    expect(store.notice?.kind).toBe("problem");
    expect(store.notice?.text).toContain("fallout2.cfg");
    expect(store.isModified(MUSIC), "the edit is kept so the user can decide").toBe(true);
    const onDisk = new TextDecoder("latin1").decode(await previewPlatform.fs.read(`${PREVIEW_INSTALL}/fallout2.cfg`));
    expect(onDisk).toContain("; edited elsewhere");
  });

  test("keeps a copy of what it replaced", async () => {
    // Earlier tests in this file back up into the same directory, and its name is only accurate to the second,
    // so the ground is cleared first and whatever is there afterwards belongs to this save.
    await previewPlatform.fs.remove(store.paths.backup);
    store.set(MUSIC, "0");
    await store.save();

    const kept = await previewPlatform.fs.list(store.paths.backup);
    expect(kept, "a save leaves the previous copy behind").toHaveLength(1);
    const copy = `${store.paths.backup}/${kept[0]!.name}/fallout2.cfg`;
    expect(new TextDecoder("latin1").decode(await previewPlatform.fs.read(copy))).toBe(fallout2cfg);
  });
});

describe("mods", () => {
  const order = async () => new TextDecoder("latin1").decode(await previewPlatform.fs.read(ORDER_FILE));
  const shown = () => store.mods.map((mod) => `${mod.enabled ? "+" : "-"}${mod.name}`);

  test("lists what the order file names, then what the folder holds and it does not", () => {
    expect(shown()).toEqual([
      "+weapon_sounds.dat",
      "-extra_music.dat",
      "+hero_appearance",
      "+old_patch.dat",
      "+old_music.dat",
      "+InventoryFilter.dat",
      "+fo2tweaks.dat",
      "-barter_prices.dat",
    ]);
    // The kinds are what makes a row's badge honest: a folder is not an archive, and an entry pointing at
    // nothing is neither.
    expect(store.mods.map((mod) => mod.kind)).toEqual([
      "dat",
      "dat",
      "folder",
      "missing",
      "missing",
      "dat",
      "dat",
      "dat",
    ]);
  });

  test("names the mod behind an entry the record claims, and nothing behind the rest", () => {
    // The one entry the preview's record lists. Everything else in that folder arrived by hand, which is
    // what an unnamed row means.
    expect(store.mods.map((mod) => mod.owner)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "FO2tweaks",
      undefined,
    ]);
  });

  test("names the mods loading against the recommendation, and sorting puts just those right", async () => {
    // The two the shipped order ranks, seeded the wrong way round. Everything else it says nothing about.
    expect(store.againstRecommendation).toEqual(["InventoryFilter.dat", "fo2tweaks.dat"]);

    store.sortMods();
    expect(shown()).toEqual([
      "+weapon_sounds.dat",
      "-extra_music.dat",
      "+hero_appearance",
      "+old_patch.dat",
      "+old_music.dat",
      "+fo2tweaks.dat",
      "+InventoryFilter.dat",
      "-barter_prices.dat",
    ]);
    expect(store.againstRecommendation, "and there is nothing left to say").toEqual([]);

    // An ordinary unsaved edit, saved and reverted like any other - it is the file's own two lines that swap.
    expect(store.modsChanged).toBe(true);
    await store.save();
    expect(await order()).toContain("old_music.dat\nfo2tweaks.dat\nInventoryFilter.dat\n");
  });

  test("counts the whole order as one unsaved change, however far a mod moves", () => {
    const before = store.modifiedCount;
    store.moveMod("hero_appearance", -1);
    store.moveMod("hero_appearance", -1);
    expect(shown()[0]).toBe("+hero_appearance");
    expect(store.modifiedCount, "one file, written whole, is one change").toBe(before + 1);
  });

  test("moving refuses to run off either end rather than wrapping around", () => {
    store.moveMod("weapon_sounds.dat", -1);
    store.moveMod("barter_prices.dat", 1);
    expect(store.modsChanged).toBe(false);
  });

  test("comments a mod out in place rather than dropping its line", async () => {
    store.toggleMod("weapon_sounds.dat");
    await store.save();

    expect(store.notice, "a save that worked has nothing to report").toBeNull();
    expect(await order()).toContain("; weapon_sounds.dat");
    expect(shown()[0], "and it keeps its place in the order").toBe("-weapon_sounds.dat");
  });

  test("writes the shown order, so a mod the file never named becomes a line of its own", async () => {
    store.toggleMod("extra_music.dat");
    await store.save();

    expect(await order()).toBe(
      "; Loaded in this order - a mod further down overrides one above it.\n" +
        "weapon_sounds.dat\nextra_music.dat\nhero_appearance\nold_patch.dat\nold_music.dat\n" +
        "InventoryFilter.dat\nfo2tweaks.dat\n; barter_prices.dat\n",
    );
  });

  test("forgetting a missing entry is the one thing that deletes a line", async () => {
    store.forgetMod("old_patch.dat");
    await store.save();

    expect(await order()).not.toContain("old_patch.dat");
    expect(shown()).not.toContain("+old_patch.dat");
  });

  test("forgetting them all drops every dead line and nothing else", async () => {
    expect(store.missingMods.map((mod) => mod.name)).toEqual(["old_patch.dat", "old_music.dat"]);

    store.forgetMissingMods();
    await store.save();

    const written = await order();
    expect(written).not.toMatch(/old_patch|old_music/);
    // The entries that resolve are untouched, commented ones included - only the dead lines went.
    expect(written).toContain("weapon_sounds.dat\n");
    expect(written).toContain("; barter_prices.dat\n");
    expect(store.missingMods).toEqual([]);
  });

  /*
    The order is written whole, so the second save is measured against a file the first one wrote. Reading the
    text back is what makes that work; without it a save is refused as somebody else's edit - and only a second
    save shows it, since the first is always measured against the file as it was read at startup.
  */
  test("a second save lands, rather than being refused as a foreign edit", async () => {
    store.toggleMod("extra_music.dat");
    await store.save();
    expect(store.modsChanged, "the file just written is the new baseline").toBe(false);

    store.moveMod("extra_music.dat", -1);
    await store.save();

    expect(store.notice).toBeNull();
    // The header stays at the top of the file; the mod that moved passes under it.
    expect(await order()).toContain("above it.\nextra_music.dat\nweapon_sounds.dat");
  });

  test("refuses and writes nothing when the file changed underneath the open window", async () => {
    store.toggleMod("weapon_sounds.dat");
    await previewPlatform.fs.write(ORDER_FILE, bytes("someone_else.dat\n"));

    await store.save();

    expect(store.notice?.kind).toBe("problem");
    expect(store.notice?.text).toContain("mods/mods_order.txt");
    expect(await order(), "the other edit stands").toBe("someone_else.dat\n");
    expect(store.modsChanged, "and this one is kept, so the user can decide").toBe(true);
  });

  test("reverting restores the order as it was read", () => {
    store.toggleMod("hero_appearance");
    store.moveMod("hero_appearance", -1);
    store.revertAll();
    expect(shown()).toEqual([
      "+weapon_sounds.dat",
      "-extra_music.dat",
      "+hero_appearance",
      "+old_patch.dat",
      "+old_music.dat",
      "+InventoryFilter.dat",
      "+fo2tweaks.dat",
      "-barter_prices.dat",
    ]);
  });
});

describe("adding an install", () => {
  test("refuses a directory that does not hold a game, naming it", async () => {
    await previewPlatform.fs.mkdir("/elsewhere/not-a-game");
    await store.addInstall("/elsewhere/not-a-game");
    expect(store.notice?.kind).toBe("problem");
    expect(store.installs.map((one) => one.path)).toEqual([PREVIEW_INSTALL]);
  });

  test("refuses one already on the list rather than listing it twice", async () => {
    await store.addInstall(PREVIEW_INSTALL);
    expect(store.notice?.kind).toBe("problem");
    expect(store.installs).toHaveLength(1);
  });

  test("adds one that does, and it survives a restart", async () => {
    await previewPlatform.fs.write("/elsewhere/Fallout 2/fallout2.exe", bytes("MZ"));
    await store.addInstall("/elsewhere/Fallout 2");
    expect(store.notice?.kind).toBe("done");

    await store.start();
    expect(store.installs.map((one) => one.path)).toContain("/elsewhere/Fallout 2");
  });
});

describe("what the browser preview cannot do", () => {
  test("reports a refusal rather than pretending the game started", async () => {
    await store.play();
    expect(store.notice?.kind).toBe("problem");
    expect(store.notice?.text).toContain("desktop build");
  });

  test("reports a refusal rather than inventing a release", async () => {
    await store.checkSfallVersion();
    expect(store.notice?.kind).toBe("problem");
    expect(store.sfallLatest, "nothing is shown as the latest version").toBeNull();
  });
});

describe("crossing the process boundary", () => {
  /*
    The desktop build runs the backend in another process, and everything the interface sends is serialized on
    the way out. The store's state lives in reactive proxies, which that serializer refuses - so an argument
    has to be unwrapped before it goes. Node's own structuredClone accepts a proxy, so this is asserted by
    identity rather than by trying to clone it: what the backend receives must not be the object the store holds.
  */
  test("unwraps the reactive state it sends, rather than handing the proxy across", async () => {
    const seen: unknown[][] = [];
    const recorder = Object.fromEntries(
      BACKEND_METHODS.map((name) => [name, (...args: unknown[]) => (seen.push(args), Promise.resolve(undefined))]),
    ) as unknown as Backend;

    await unwrapArguments(recorder).saveState({
      installs: store.installs,
      unavailable: [],
      theme: store.theme,
    } as never);

    const sent = seen[0]![0] as { installs: unknown };
    expect(sent.installs, "the proxy itself would not survive the channel").not.toBe(store.installs);
    expect(sent.installs).toEqual(store.installs);
  });
});

describe("a value ZAX pins", () => {
  const PINNED = "hires.MAIN.UAC_AWARE";
  const onDisk = async () => {
    const raw = await previewPlatform.fs.read(`${PREVIEW_INSTALL}/f2_res.ini`);
    return [...raw].map((b) => String.fromCharCode(b)).join("");
  };

  /*
    The seeded fixture ships UAC_AWARE=1 and ZAX pins it off. It used to sit as a pending change, which left
    the install permanently reading "1 unsaved" with nothing the user had done to account for it.
  */
  test("is written on load rather than counted as an unsaved change", async () => {
    expect(store.valueOf(PINNED)).toBe("0");
    expect(store.isModified(PINNED)).toBe(false);
    expect(store.modifiedCount, "a fresh install reads as saved").toBe(0);
    // The file itself, not just what the interface reports about it.
    expect(await onDisk()).toContain("UAC_AWARE=0");
  });

  test("is written whether or not autosave is on, since it is not the user's edit", async () => {
    await store.setAutosave(false);
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/f2_res.ini`, bytes(f2resini));
    expect(await onDisk(), "back to the fixture's own value").toContain("UAC_AWARE=1");

    await store.start();

    expect(store.autosave).toBe(false);
    expect(await onDisk()).toContain("UAC_AWARE=0");
    expect(store.modifiedCount).toBe(0);
  });

  test("queues nothing once its file is gone, so saving cannot create the file", async () => {
    await previewPlatform.fs.remove(`${PREVIEW_INSTALL}/f2_res.ini`);
    await store.start();

    expect(store.hasFile("f2_res.ini")).toBe(false);
    expect(store.isModified(PINNED), "a pinned value for an absent file would be written on the next save").toBe(false);
    expect(store.modifiedCount, "nothing else is pending either").toBe(0);
  });
});

/*
  The two marks in the top bar. What they must not do is disagree with the dots on the tabs below them, and a
  pinned value is exactly where they could: it sits in the overrides and belongs to no edit the user made.
*/
describe("the unsaved marks", () => {
  const MUSIC = "game.sound.music";

  test("the settings mark appears on an edit and clears on revert, in step with the file tab's dot", () => {
    expect(store.settingsChanged, "a fresh install carries ZAX's pinned values and no edit").toBe(false);

    store.set(MUSIC, store.baselineOf(MUSIC) === "1" ? "0" : "1");

    expect(store.settingsChanged).toBe(true);
    expect(store.modifiedInGroup("fallout2.cfg"), "and the tab under it is marked too").toBe(1);

    store.revert(MUSIC);
    expect(store.settingsChanged).toBe(false);
  });

  test("neither mark answers for the other's view", () => {
    store.moveMod("hero_appearance", -1);
    expect(store.modsChanged).toBe(true);
    expect(store.settingsChanged, "a mod that moved is not a settings edit").toBe(false);

    store.set(MUSIC, store.baselineOf(MUSIC) === "1" ? "0" : "1");
    store.revertAll();
    expect(store.settingsChanged).toBe(false);
    expect(store.modsChanged).toBe(false);
  });
});

/*
  Autosave is glue: nothing it does is visible in a single call, and the parts that can go wrong are the timer
  and the guard around it. Real timers rather than fake ones, because what is under test is that the write
  happens on its own - a faked clock would prove only that the callback was registered.
*/
describe("autosave", () => {
  const MUSIC = "game.sound.music";
  const settle = () => new Promise((resolve) => setTimeout(resolve, 900));

  test("writes an edit without a save, once the run of edits stops", async () => {
    const before = store.baselineOf(MUSIC);
    const wanted = before === "1" ? "0" : "1";
    await store.setAutosave(true);

    store.set(MUSIC, wanted);
    expect(store.isModified(MUSIC), "still pending the moment the edit is made").toBe(true);
    await settle();

    // Read back through a fresh start, which is the only proof the value reached the file.
    await store.start();
    expect(store.baselineOf(MUSIC)).toBe(wanted);
  });

  test("says nothing on success, like any other save", async () => {
    await store.setAutosave(true);
    store.set(MUSIC, store.baselineOf(MUSIC) === "1" ? "0" : "1");
    await settle();
    expect(store.notice).toBeNull();
  });

  test("turning it off cancels the write its own edit scheduled", async () => {
    const before = store.baselineOf(MUSIC);
    await store.setAutosave(true);
    store.set(MUSIC, before === "1" ? "0" : "1");
    // Inside the coalescing window: the user changed their mind before the write went out.
    await store.setAutosave(false);
    await settle();

    expect(store.isModified(MUSIC), "the edit is still pending, waiting for Save").toBe(true);
    await store.start();
    expect(store.baselineOf(MUSIC), "and nothing reached the file").toBe(before);
  });

  test("stays off unless asked, so no install is written to by opening the application", () => {
    expect(store.autosave).toBe(false);
  });
});

describe("a long operation", () => {
  test("reports its step and proportion while it runs, and nothing once it has stopped", async () => {
    expect(store.progressText, "nothing is running").toBeNull();

    // What the backend reports as a download advances. Delivered through the same subscription the desktop
    // build uses - the preview builds one over its own in-process backend.
    store.busy = "Updating sfall";
    store.progress = { step: "Downloading sfall 4.5", received: 440_000, total: 880_000 };
    expect(store.progressText).toBe("Downloading sfall 4.5 - 50% of 0.8 MB");

    // A step with no length says what it is doing and claims no proportion it cannot know.
    store.progress = { step: "Merging your settings" };
    expect(store.progressText).toBe("Merging your settings");

    store.busy = null;
    store.progress = null;
    expect(store.progressText).toBeNull();
  });

  test("says a second request was refused rather than dropping it in silence", async () => {
    // A click during an update used to do nothing at all, which reads as a broken button rather than a busy
    // application - and these operations run for minutes on a poor connection.
    store.busy = "Updating sfall";
    await store.scan();

    expect(store.notice).toEqual({ kind: "problem", text: "Updating sfall is still running - wait for it to finish." });
    store.busy = null;
  });
});

describe("mod settings", () => {
  const settingOf = (id: string) => {
    const found = store.modSettings.flatMap((group) => group.settings).find((setting) => setting.id === id);
    if (!found) throw new Error(`${id} is not in the seeded schema`);
    return found;
  };

  test("an installed mod's schema loads with its values read from its own ini", () => {
    expect(store.modSettings.map((group) => group.name)).toEqual(["FO2tweaks"]);
    expect(store.modSettings[0]?.files).toEqual(["mods/fo2tweaks.ini"]);
    expect(store.valueOf("fo2tweaks.main.autodoors")).toBe("1");
    expect(store.valueOf("fo2tweaks.main.max_knockback")).toBe("-1");
  });

  test("an edit saves through the lossless path: one line changes, the comments stay", async () => {
    store.set("fo2tweaks.main.autodoors", "2");
    expect(store.modsViewChanged, "the Mods view carries the unsaved mark for it").toBe(true);
    await store.save();

    const written = new TextDecoder().decode(await previewPlatform.fs.read(MOD_INI));
    expect(written).toContain("autodoors=2");
    expect(written, "the file's own comments are its documentation and survive the write").toContain(
      "; Automatically open/walk through unlocked doors when not in combat",
    );
    expect(store.isModified("fo2tweaks.main.autodoors"), "the file just written is the new baseline").toBe(false);
    expect(store.valueOf("fo2tweaks.main.autodoors")).toBe("2");
  });

  test("a cross-file gate resolves its controller in the catalog, not the mod's own schema", () => {
    const def = store.modSettings[0]?.settings.find((s) => s.id === "fo2tweaks.main.damage_mod");
    const gate = store.gateOf(def!);
    expect(gate?.controller.id).toBe("sfall.Misc.DamageFormula");
    // Active exactly when the install's ddraw.ini holds the value the gate names - read, not assumed.
    expect(gate?.active).toBe(store.valueOf("sfall.Misc.DamageFormula") === "0");
  });

  test("one click sets the whole chain a gated setting waits on", () => {
    // The party toggle waits on the mod's own run speed component, which waits on sfall's filesystem
    // override. The note names only the first, so a fix stopping there would leave the setting as inert.
    const dude = settingOf("fo2tweaks.run_speed.dude");
    expect(store.requirementsFor(dude)?.map((r) => [r.def.id, r.value])).toEqual([
      ["fo2tweaks.main.run_speed", "1"],
      ["sfall.Misc.UseFileSystemOverride", "1"],
    ]);

    store.satisfyGate(dude);

    expect(store.valueOf("fo2tweaks.main.run_speed")).toBe("1");
    expect(store.valueOf("sfall.Misc.UseFileSystemOverride"), "the one in another file, and another tab").toBe("1");
    expect(store.gateOf(dude)?.active).toBe(true);
    expect(store.notice?.kind).toBe("done");
    expect(store.notice?.text).toContain("2 settings");
  });

  test("offers nothing where the gate names no one value to write", () => {
    // "any key but none" cannot be answered by writing a value, and picking a key here would rebind the
    // user's keyboard for them - so the row keeps its note and no button.
    const fastMove = store.defOf("sfall.Input.FastMoveFromContainer");
    expect(fastMove && store.gateOf(fastMove)?.active).toBe(false);
    expect(fastMove && store.requirementsFor(fastMove)).toBeNull();
  });

  test("opening the mod's own file refuses in the preview, with the reason named", async () => {
    await store.openModIni("fo2tweaks", "mods/fo2tweaks.ini");
    expect(store.notice?.kind).toBe("problem");
    expect(store.notice?.text).toContain("desktop build");
  });
});

describe("a mod no feed follows", () => {
  test("is listed from the record, removable, and the listing survives the flow's own refresh", async () => {
    const held = await loadRecord(previewPlatform, PREVIEW_INSTALL);
    await saveRecord(previewPlatform, {
      path: held.path,
      mods: [
        ...held.mods,
        {
          id: "oldmod",
          version: "3",
          complete: true,
          files: ["mods/oldmod.dat"],
          manifest: 'spec: 1\nid: oldmod\nname: Old Mod\nversion: "3"\ngame: fallout2\n',
          shipped: {},
        },
      ],
    });
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/mods/oldmod.dat`, bytes("DAT"));

    await store.loadModOffers();
    const offer = store.modListing?.offers.find((one) => one.id === "oldmod");
    expect(offer?.availability).toEqual({ kind: "unfollowed" });

    // Removing it also restores the seeded record, so the cases after this one see the install they expect.
    await store.removeMod(offer!);
    expect(store.notice?.kind).toBe("done");
    expect(store.modListing, "the flow's closing refresh must survive its own busy gate").not.toBeNull();
    expect(store.modListing?.offers.some((one) => one.id === "oldmod")).toBe(false);
  });
});

describe("mod flows and unsaved edits", () => {
  test("nothing installs over unsaved edits - the flow refuses before anything runs", async () => {
    store.set("fo2tweaks.main.autodoors", "2");
    const offer = {
      id: "fo2tweaks",
      name: "FO2tweaks",
      version: "15",
      type: "pluggable" as const,
      availability: { kind: "upgrade" as const, from: "14.7" },
    };
    await store.prepareMod(offer);
    expect(store.notice?.kind).toBe("problem");
    expect(store.notice?.text).toContain("unsaved");
    expect(store.modPlan, "no plan was prepared").toBeNull();
    store.revert("fo2tweaks.main.autodoors");
  });

  test("restore refuses over unsaved edits too - it rewrites the same files the other flows do", async () => {
    store.set("fo2tweaks.main.autodoors", "2");
    const offer = {
      id: "fo2tweaks",
      name: "FO2tweaks",
      version: "14.7",
      type: "pluggable" as const,
      availability: { kind: "retry" as const, version: "14.7" },
    };
    await store.restoreMod(offer);
    expect(store.notice?.kind).toBe("problem");
    expect(store.notice?.text).toContain("unsaved");
    store.revert("fo2tweaks.main.autodoors");
  });
});

describe("a mod that offers parts", () => {
  const groups = [
    {
      label: "Head",
      pick: "any" as const,
      options: [{ id: "head", label: "New head", archive: "head.dat", entries: ["head.dat"] }],
    },
    {
      label: "Voice",
      pick: "one" as const,
      options: [
        { id: "joey", label: "Joey Bracken", archive: "joey.dat", entries: ["joey.dat"], needs: "head" },
        { id: "tom", label: "Tom Regan", archive: "tom.dat", entries: ["tom.dat"], needs: "head" },
      ],
    },
  ];
  const offer = (parts: { selection: string[]; dropped: string[]; ask: boolean }) => ({
    id: "cassidy",
    name: "Cassidy",
    version: "1.2",
    type: "pluggable" as const,
    choices: { what: "parts" as const, groups, ...parts },
    availability: { kind: "install" as const },
  });

  test("asks before planning when the choice cannot be carried over", async () => {
    await store.prepareMod(offer({ selection: [], dropped: [], ask: true }));
    expect(store.modParts?.chosen).toEqual([]);
    expect(store.modPlan, "nothing is downloaded until the choice is made").toBeNull();
    store.dismissModParts();
  });

  test("carries a recorded choice straight to the plan, without asking", async () => {
    // The preview refuses the feed's network, so the flow ends in that refusal - which is after the point
    // this is about: the dialog that never opened.
    await store.prepareMod(offer({ selection: ["head", "joey"], dropped: [], ask: false }));
    expect(store.modParts, "an upgrade re-installs the same parts without a question").toBeNull();
    expect(store.notice?.kind).toBe("problem");
  });

  test("unticks what depended on a part when that part goes, and keeps a pick-one group to one", async () => {
    await store.prepareMod(offer({ selection: [], dropped: [], ask: true }));
    store.setModPart("head", true);
    store.setModPart("joey", true);
    expect(store.modParts?.chosen).toEqual(["head", "joey"]);

    store.setModPart("tom", true);
    expect(store.modParts?.chosen, "the other voice went with it").toEqual(["head", "tom"]);

    // Nothing else could have installed: the voice needs the head, so the dialog cannot sit in a state the
    // install would only refuse.
    store.setModPart("head", false);
    expect(store.modParts?.chosen).toEqual([]);
    store.dismissModParts();
  });
});

describe("a running mod flow", () => {
  test("marks the control that started it, and clears the mark however the flow ends", async () => {
    const offer = {
      id: "fo2tweaks",
      name: "FO2tweaks",
      version: "14.7",
      type: "pluggable" as const,
      availability: { kind: "retry" as const, version: "14.7" },
    };
    // Nothing of this one is waiting to be restored, so the flow fails - the harder case for the clearing: a
    // row left marked would sit there claiming to work with nothing running behind it.
    const running = store.restoreMod(offer);
    expect(store.modWorking("fo2tweaks", "restore"), "the control that started it says so").toBe(true);
    expect(store.modWorking("fo2tweaks", "remove"), "and no other control on the row does").toBe(false);
    expect(store.modWorking("oldmod", "restore"), "nor the same control on another row").toBe(false);

    await running;
    expect(store.notice?.kind, "the failure is still reported").toBe("problem");
    expect(store.modWorking("fo2tweaks", "restore"), "and the mark went with the operation").toBe(false);
  });
});

describe("a mod that must be pointed at another game", () => {
  const offer = {
    id: "fo2tweaks",
    name: "Fallout et tu",
    version: "1.16.3771",
    type: "base" as const,
    becomes: "fo1in2" as const,
    creates: "Fallout1in2",
    asks: [{ id: "fallout1", label: "Your Fallout 1 folder", holds: "master.dat" }],
    availability: { kind: "install" as const },
  };

  test("asks for the folder before anything is downloaded", async () => {
    await store.prepareMod(offer);
    expect(store.modInputs?.offer.id).toBe("fo2tweaks");
    expect(store.modInputs?.answers).toEqual({});
    expect(store.modPlan, "nothing is planned until the question is answered").toBeNull();
    store.dismissModInputs();
    expect(store.modInputs).toBeNull();
  });

  test("carries the answers on to the plan, which is where they are checked", async () => {
    await store.prepareMod(offer);
    store.modInputs = { offer, chosen: [], answers: { fallout1: "/games/fallout1" } };
    // The preview refuses the feed's network, so the flow ends in that refusal - which is past the point
    // this is about: the question was closed and the plan was attempted with what was answered.
    await store.confirmModInputs();
    expect(store.modInputs).toBeNull();
    expect(store.notice?.kind).toBe("problem");
  });
});

/**
 * What an install of a base mod does to the list of games, which is the half of the flow that outlives the
 * operation: everything else it reports is a notice the user dismisses.
 *
 * Driven against a stubbed backend rather than a real install, because the two outcomes being distinguished
 * here are what the store does with what came back - and reaching them for real needs the network, an
 * installer to run and, for the second, a copy of Fallout 1.
 */
describe("installing a version other than the newest", () => {
  const offer = {
    id: "rpu23",
    name: "Restoration Project Updated 2.3",
    version: "2.3.34",
    type: "base" as const,
    availability: { kind: "upgrade" as const, from: "2.3.32" },
  };

  afterEach(() => vi.restoreAllMocks());

  test("asks only for what the install could move to, not for every release ever published", async () => {
    const versions = vi.spyOn(hostBackend, "modVersions").mockResolvedValue(["2.3.34", "2.3.33"]);
    await store.chooseModVersion(offer);
    // What is installed goes with the request: the backend owns the comparison, which is the only place the
    // release line ordering these versions is known.
    expect(versions).toHaveBeenCalledWith("rpu23", "2.3.32");
    expect(store.modVersionPick).toEqual({ offer, versions: ["2.3.34", "2.3.33"], read: true });
  });

  test("plans the version picked rather than the one the row names", async () => {
    const plan = vi
      .spyOn(hostBackend, "planMod")
      .mockResolvedValue({ kind: "base", version: "2.3.33", fingerprint: "f" } as never);
    await store.prepareMod(offer, undefined, undefined, "2.3.33");
    expect(plan).toHaveBeenCalledWith(expect.anything(), "rpu23", undefined, undefined, "2.3.33");
    expect(store.modPlan?.version).toBe("2.3.33");
  });

  test("closes the dialog rather than sitting on a list that will never arrive", async () => {
    vi.spyOn(hostBackend, "modVersions").mockRejectedValue(new Error("the machine cannot be reached"));
    await store.chooseModVersion(offer);
    expect(store.modVersionPick, "a dialog still reading is worse than none").toBeNull();
    expect(store.notice?.kind).toBe("problem");
    expect(store.notice?.text).toContain("the machine cannot be reached");
  });

  test("drops the choice when the dialog is dismissed", async () => {
    vi.spyOn(hostBackend, "modVersions").mockResolvedValue(["2.3.34"]);
    await store.chooseModVersion(offer);
    store.dismissModVersion();
    expect(store.modVersionPick).toBeNull();
  });
});

describe("what an installed base mod does to the list of games", () => {
  const settled = { standing: {}, unfollowed: [] };

  /** Stands in for the operation, so what is asserted is the store's handling of the outcome. */
  const answering = (outcome: unknown, identifiedAs: string) => {
    vi.spyOn(hostBackend, "installMod").mockResolvedValue(outcome as never);
    vi.spyOn(hostBackend, "identifyInstall").mockResolvedValue(identifiedAs as never);
    // Re-read after any install; stubbed because the preview refuses the feeds' network and a refusal here
    // would end the operation before the assertions below are about anything.
    vi.spyOn(hostBackend, "modInstallState").mockResolvedValue(settled as never);
  };

  const stored = async () => new TextDecoder().decode(await previewPlatform.fs.read("preview/config/zax.yml"));

  afterEach(() => vi.restoreAllMocks());

  test("relabels the install in place when the mod makes it a different game", async () => {
    answering(
      { version: "2.4.34", becomes: "fallout2rpu", renamed: 0, conflicts: [], backup: "preview/cache/backup" },
      "fallout2rpu",
    );
    expect(store.installs.find((one) => one.path === PREVIEW_INSTALL)?.type).toBe("fallout2up");

    store.modPlan = {
      version: "2.4.34",
      offer: {
        id: "rpu",
        name: "Restoration Project Updated",
        version: "2.4.34",
        type: "base",
        availability: { kind: "install" },
      },
      plan: {
        kind: "base",
        version: "2.4.34",
        asset: "rpu_v2.4.34.zip",
        route: "other",
        download: 1024,
        becomes: "fallout2rpu",
        fingerprint: "rpu-2.4.34",
      },
    };
    await store.confirmModInstall();

    // No second row: the game the user already had is the game the mod transformed.
    expect(store.installs).toHaveLength(1);
    expect(store.installs[0]?.type, "read back off the directory, not taken from the outcome").toBe("fallout2rpu");

    // The type is not in the state file at all - only the path is, and startup identifies every stored path
    // by reading it. So a restart reports what the directory holds rather than what was last shown: here
    // that is still the patched fixture, since a stubbed install never touched it. The directory being the
    // authority is also why a game modded outside ZAX reads correctly on the next run.
    expect(await stored()).not.toContain("fallout2rpu");
    await store.start();
    expect(store.installs[0]?.type, "which a stub cannot fake - startup reads the folder itself").toBe("fallout2up");
  });

  test("adds a second game when the mod creates one beside this install", async () => {
    const created = `${PREVIEW_INSTALL}/Fallout1in2`;
    answering({ version: "1.16.3771", created, extracted: 8602, conflicts: [] }, "fo1in2");

    store.modPlan = {
      version: "1.16.3771",
      offer: {
        id: "fo1in2",
        name: "Fallout et tu",
        version: "1.16.3771",
        type: "base",
        availability: { kind: "install" },
      },
      plan: {
        kind: "creates",
        version: "1.16.3771",
        directory: "Fallout1in2",
        asset: "Fallout1in2.zip",
        download: 2048,
        unpacked: 4096,
        inputs: { fallout1: "/games/fallout1" },
        becomes: "fo1in2",
        fingerprint: "fo1in2-1.16.3771",
      },
    };
    await store.confirmModInstall();

    expect(store.installs.map((one) => one.path)).toEqual([PREVIEW_INSTALL, created]);
    expect(store.installs[1]?.type).toBe("fo1in2");
    // The host is untouched: what the mod made is a game inside it, not a change to it.
    expect(store.installs[0]?.type).toBe("fallout2up");
    // The path is stored, unlike the type: the second game has to be found again next time without the
    // install that made it having to be consulted.
    expect(await stored(), "and it survives a restart").toContain(created);
    // Said in the notice too, since a game appearing in the sidebar unannounced is a surprise.
    expect(store.notice?.text).toContain("is now on the list of installations");
  });
});

describe("engines", () => {
  afterEach(() => vi.restoreAllMocks());

  const launching = () => vi.spyOn(hostBackend, "launch").mockResolvedValue(undefined as never);

  test("Run starts the game on its own executable", async () => {
    const launch = launching();
    await store.play();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ path: PREVIEW_INSTALL }), null, null);
  });

  test("Run in CE starts it through the engine", async () => {
    const launch = launching();
    await store.play("fallout2-ce");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ path: PREVIEW_INSTALL }), null, "fallout2-ce");
  });

  test("keeps a check across installs, and re-reads what is deployed in the one arrived at", async () => {
    // selectInstall is a no-op on the already-selected path (it would otherwise drop unsaved edits on a
    // re-click), so leaving has to mean an actual other install, not PREVIEW_INSTALL a second time.
    const listing = vi.spyOn(hostBackend, "availableEngines").mockResolvedValue([] as never);
    store.installs = [...store.installs, { path: "/games/other", type: "fallout2" }];
    const published = { release: "continious", published: "2026-08-23T09:37:22Z", asset: null, commit: null };
    store.engineLatest = { "fallout2-ce": published };
    await store.selectInstall("/games/other");
    // The project published one release, not one per game folder, so the check outlives the switch.
    expect(store.engineLatest).toEqual({ "fallout2-ce": published });
    // What is the folder's - which engine is deployed in it - is read again for the one arrived at.
    expect(listing).toHaveBeenCalledWith(expect.objectContaining({ path: "/games/other" }));
    expect(store.engines).toEqual([]);
  });
});

describe("a setting both engines changed", () => {
  const BARTER = "sfall.Interface.ExpandBarter";
  const read = async (name: string) =>
    new TextDecoder("latin1").decode(await previewPlatform.fs.read(`${PREVIEW_INSTALL}/${name}`));

  test("writes nothing until the user says which value survives, then writes that one everywhere", async () => {
    // Both sides moved off what ZAX wrote, so neither is the newer one. Reconciliation offers the choice
    // rather than picking, and the pick is an ordinary pending edit - revertible until it is saved.
    await previewPlatform.fs.write(
      `${PREVIEW_INSTALL}/fallout2.cfg`,
      bytes(`${fallout2cfg}\n[ui]\nexpand_barter_window=0\n`),
    );
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
    await store.start();
    store.set(BARTER, "0");
    await store.save();

    await previewPlatform.fs.write(
      `${PREVIEW_INSTALL}/fallout2.cfg`,
      bytes(`${fallout2cfg}\n[ui]\nexpand_barter_window=1\n`),
    );
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=2\n"));
    await store.start();

    expect(store.settingsChoices.map((one) => one.id)).toContain(BARTER);
    expect(store.isModified(BARTER), "nothing is written while the choice stands").toBe(false);

    store.chooseLinked(BARTER, "1");
    expect(
      store.settingsChoices.map((one) => one.id),
      "the prompt closes on the answer",
    ).not.toContain(BARTER);
    expect(store.isModified(BARTER), "and leaves an edit that can still be reverted").toBe(true);

    await store.save();
    expect(await read("ddraw.ini")).toContain("ExpandBarter=1");
    expect(await read("fallout2.cfg")).toContain("expand_barter_window=1");
    expect(await read("fission.cfg")).toContain("EnhancedBarter=1");
  });
});

describe("the settings tabs an install offers", () => {
  afterEach(() => vi.restoreAllMocks());

  const deployed = (id: string) => ({
    id,
    release: "continious",
    published: "2026-08-23T09:37:22Z",
    complete: true,
    files: ["fallout2-ce.exe"],
  });

  /** The listing the Engines tab reads, with the named engines installed here and the rest not. */
  const listing = (...installed: string[]) =>
    vi.spyOn(hostBackend, "availableEngines").mockResolvedValue(
      ENGINES.map((one) => ({
        id: one.id,
        name: one.name,
        short: one.short,
        page: one.page,
        releases: one.releases,
        build: { asset: "a.zip", program: "a.exe" },
        installed: installed.includes(one.id) ? deployed(one.id) : null,
        cached: false,
      })) as never,
    );

  const idsOffered = () => store.settingsGroups.map((one) => one.group.id);

  test("offers the game's own three and no engine, on an install that has none", async () => {
    listing();
    await store.start();
    expect(idsOffered()).toEqual(["fallout2.cfg", "f2_res.ini", "ddraw.ini"]);
  });

  test("offers an installed engine's tab once that engine has written its settings", async () => {
    listing("fission");
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
    await store.start();
    expect(idsOffered()).toContain("fission");
    expect(store.groupRefusal("fission")).toBeNull();
  });

  test("offers an installed engine that has not written its settings, and refuses its rows", async () => {
    // Not hidden: the tab is how a user finds out what the engine can do. Not writable either - ZAX would be
    // choosing the engine's configuration for it, and fallout2-ce's own one-shot import checks for the very
    // section a premature write would create.
    listing("fission");
    await store.start();
    expect(idsOffered()).toContain("fission");
    expect(store.groupRefusal("fission")).toContain("Run the game once");
  });

  test("leaves a tab pointing at an engine the install arrived at does not have", async () => {
    listing("fission");
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
    await store.start();
    store.settingsTab = "fission";

    listing();
    store.installs = [...store.installs, { path: "/games/other", type: "fallout2" }];
    await store.selectInstall("/games/other");
    expect(store.settingsTab, "a selection nothing offers would show neither that tab nor any other").toBe(
      "fallout2.cfg",
    );
  });

  test("keeps a tab that belongs to no layout group across the switch", async () => {
    listing();
    await store.start();
    store.settingsTab = "trouble";
    store.installs = [...store.installs, { path: "/games/other", type: "fallout2" }];
    await store.selectInstall("/games/other");
    expect(store.settingsTab).toBe("trouble");
  });
});

describe("a row drawn under an engine's tab", () => {
  const BARTER = "sfall.Interface.ExpandBarter";
  const def = SETTINGS.find((one) => one.id === BARTER)!;

  test("edits the address of the component whose tab it is", () => {
    expect(store.targetFor(def, "ddraw.ini")).toMatchObject({ file: "ddraw.ini", key: "ExpandBarter" });
    expect(store.targetFor(def, "fallout2-ce")).toMatchObject({ file: "fallout2.cfg", key: "expand_barter_window" });
    expect(store.targetFor(def, "fission")).toMatchObject({ file: "fission.cfg", key: "EnhancedBarter" });
    // A search result names no group, and gets the address the setting's own id was minted from.
    expect(store.targetFor(def)).toMatchObject({ file: "ddraw.ini", key: "ExpandBarter" });
  });

  test("names every other address the value reaches, on the components this install has", async () => {
    // Fission is installed and has run, fallout2-ce is not installed at all. So the mark names Fission's
    // address and says nothing about CE's - a link to software that is not here would appear on nearly every
    // vanilla row and distinguish nothing, which is the whole point of showing a mark.
    vi.spyOn(hostBackend, "availableEngines").mockResolvedValue([
      {
        id: "fission",
        name: "Fallout Fission",
        short: "Fission",
        page: "",
        releases: "tagged",
        build: null,
        installed: {
          id: "fission",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: [],
        },
        cached: false,
      },
    ] as never);
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
    await store.start();

    expect(store.linkedTo(def, "ddraw.ini")).toEqual([
      { at: expect.objectContaining({ file: "fission.cfg", key: "EnhancedBarter" }), live: true },
    ]);
    // Read from the other side, the row's own address is the one left out.
    expect(store.linkedTo(def, "fission").map((one) => one.at.file)).toEqual(["ddraw.ini"]);
    // A setting only one component has is not linked to anything, so its row carries no chain at all.
    expect(
      store.linkedTo(
        SETTINGS.find((one) => one.id === "sfall.Misc.SingleCore")!,
        "ddraw.ini",
      ),
    ).toEqual([]);
  });

  test("names an installed engine's address before that engine has written its settings, and marks it", async () => {
    // The link is real and about to matter, so it is named - but flagged, because a save does not reach it
    // yet and "also writes X" of a file ZAX is deliberately leaving alone is a lie in the other direction.
    vi.spyOn(hostBackend, "availableEngines").mockResolvedValue([
      {
        id: "fission",
        name: "Fallout Fission",
        short: "Fission",
        page: "",
        releases: "tagged",
        build: null,
        installed: {
          id: "fission",
          release: "continious",
          published: "2026-08-23T09:37:22Z",
          complete: true,
          files: [],
        },
        cached: false,
      },
    ] as never);
    await store.start();
    expect(store.linkedTo(def, "ddraw.ini")).toEqual([
      { at: expect.objectContaining({ file: "fission.cfg" }), live: false },
    ]);
  });

  test("marks nothing on an install carrying no alternative engine", async () => {
    vi.spyOn(hostBackend, "availableEngines").mockResolvedValue([] as never);
    await store.start();
    expect(store.linkedTo(def, "ddraw.ini")).toEqual([]);
  });

  test("carries the gate of that address alone", async () => {
    // Fission refuses every enhancement while its strict-vanilla switch is on. That says nothing about the
    // same setting's sfall half, which is the case a gate on the setting rather than the target would get
    // wrong: the sfall row would grey out because a file sfall never reads holds a 1.
    await previewPlatform.fs.write(
      `${PREVIEW_INSTALL}/fission.cfg`,
      bytes("[enhancements]\nStrictVanilla=1\nEnhancedBarter=0\n"),
    );
    await store.start();
    expect(store.gateOf(def, "ddraw.ini"), "sfall's half is gated by nothing").toBeNull();
    expect(store.gateOf(def, "fission")?.active, "and Fission's half waits on the switch").toBe(false);
  });
});

describe("the checks ZAX makes for itself at startup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // The store is one object across the file, and these three outlive an install. Cleared here so a case
    // below cannot read an answer this block put there.
    store.zaxLatest = null;
    store.sfallLatest = null;
    store.engineLatest = {};
  });

  const published = { release: "continious", published: "2026-08-23T09:37:22Z", asset: null, commit: null };

  const answering = () => {
    vi.spyOn(hostBackend, "latestZax").mockResolvedValue({ version: "9.9.9", url: "https://example.invalid" });
    vi.spyOn(hostBackend, "latestSfall").mockResolvedValue({ version: "4.4.9", url: "https://example.invalid" });
    return vi.spyOn(hostBackend, "latestEngine").mockResolvedValue(published);
  };

  test("asks at once for what ZAX, sfall and the engines have published", async () => {
    answering();
    await store.checkForUpdates();

    expect(store.zaxLatest).toBe("9.9.9");
    expect(store.sfallLatest?.version).toBe("4.4.9");
    expect(store.engineLatest["fallout2-ce"]).toEqual(published);
  });

  test("does not hold the busy gate, which would refuse the user's first click", async () => {
    answering();
    const during = store.checkForUpdates();
    expect(store.busy, "nobody asked for these, so they must not lock the interface").toBeNull();
    await during;
    expect(store.notice, "nor report a result nobody is waiting for").toBeNull();
  });

  test("leaves the fields as they were when the machine cannot be reached, and says nothing", async () => {
    // Nothing is stubbed, so the preview host refuses every one of them the way an offline machine would.
    await store.checkForUpdates();

    expect(store.zaxLatest).toBeNull();
    expect(store.sfallLatest).toBeNull();
    expect(store.engineLatest).toEqual({});
    expect(store.notice, "several notices about being offline would bury the ones that matter").toBeNull();
  });
});

describe("the feeds against a change of game", () => {
  afterEach(() => vi.restoreAllMocks());

  const other = { path: "/games/other", type: "fallout2" } as const;
  const feeds: ModFeedListing = { published: [], failures: [] };
  /**
   * Told apart by one recorded row: which install's answer arrived is the whole question in this block, and a
   * mod no feed follows is the cheapest thing to write that only an install's own record can produce.
   */
  const standingOf = (id: string): ModInstallState => ({
    standing: {},
    unfollowed: [{ id, name: id, version: "1", type: "pluggable", availability: { kind: "unfollowed" } }],
  });
  /**
   * What the tab draws for one install. The offers alone, not the whole listing: the failures come from the
   * published half, which the startup read owns and can land on at any point in a case.
   */
  const offersFor = (id: string) => standingOf(id).unfollowed;

  /** The published half in place, as it is a moment after startup, so a case is about the other half. */
  const published = () => {
    store.modFeeds = feeds;
    return vi.spyOn(hostBackend, "publishedMods").mockResolvedValue(feeds);
  };

  test("are not read again for a change of game - one release is published for every install", async () => {
    const asked = published();
    vi.spyOn(hostBackend, "modInstallState").mockResolvedValue(standingOf("mine"));
    store.installs = [...store.installs, other];

    await store.selectInstall(other.path);
    await store.selectInstall(PREVIEW_INSTALL);

    // The whole point of the two halves: a switch asks what changed - the folder - and nothing else.
    expect(asked, "a repository publishes the same release whichever game is selected").not.toHaveBeenCalled();
  });

  test("are read again by Refresh, which is the one control that asks them", async () => {
    const asked = published();
    vi.spyOn(hostBackend, "modInstallState").mockResolvedValue(standingOf("mine"));

    await store.loadModOffers(true);

    expect(asked).toHaveBeenCalledWith(true);
  });

  test("the game's own half is read again for the game arrived at, without waiting to be asked", async () => {
    published();
    // Held open so the switch is over while the read is still out, which is the state the tab has to describe.
    let release = (): void => {};
    const held = new Promise<ModInstallState>((resolve) => {
      release = () => resolve(standingOf("mine"));
    });
    const asked = vi.spyOn(hostBackend, "modInstallState").mockReturnValue(held);
    store.installs = [...store.installs, other];

    // The switch reads the install itself before it reaches the feeds, and the tab is on screen throughout.
    const switching = store.selectInstall(other.path);
    expect(store.modListing, "the previous game's offers go at once").toBeNull();
    expect(store.readingOffers, "and the tab says so from the same moment").toBe(true);
    await switching;
    // Off the `busy` gate: the switch itself is over before the answer is, and a read nobody asked for must
    // not grey out the controls.
    expect(store.busy).toBeNull();
    // What the tab must not be left holding is the previous game's offers, nor - for however long the read
    // takes - the claim that the feeds were never asked.
    expect(store.modListing).toBeNull();
    expect(store.readingOffers).toBe(true);

    release();
    await vi.waitFor(() => expect(store.modListing?.offers).toEqual(offersFor("mine")));
    expect(store.readingOffers).toBe(false);
    expect(asked).toHaveBeenCalledWith(expect.objectContaining({ path: other.path }));
  });

  test("survive a reread of the same game, which is what saving and installing do", async () => {
    published();
    vi.spyOn(hostBackend, "modInstallState").mockResolvedValue(standingOf("read-once"));
    await store.loadModOffers();
    expect(store.modListing?.offers).toEqual(offersFor("read-once"));

    // Installing an engine rereads the install. Nothing about which mods are on offer changed, and blanking
    // the tab back to unread over it is the bug this pins.
    vi.spyOn(hostBackend, "installEngine").mockResolvedValue({ backup: null } as never);
    await store.installEngine("fallout2-ce");

    expect(store.modListing?.offers, "the folder on screen is the one this was read for").toEqual(
      offersFor("read-once"),
    );
  });

  test("drop an answer that arrives for a game that is no longer the selected one", async () => {
    published();
    // Held open so the second switch lands while the first read is still out - the only way the two cross.
    let release = (): void => {};
    const held = new Promise<ModInstallState>((resolve) => {
      release = () => resolve(standingOf("stale"));
    });
    vi.spyOn(hostBackend, "modInstallState").mockImplementation((install) =>
      install.path === other.path ? held : Promise.resolve(standingOf("mine")),
    );
    store.installs = [...store.installs, other];

    await store.selectInstall(other.path);
    await store.selectInstall(PREVIEW_INSTALL);
    release();
    await held;

    await vi.waitFor(() => expect(store.modListing?.offers).toEqual(offersFor("mine")));
  });
});
