import { beforeEach, describe, expect, test } from "vitest";
import { SETTINGS } from "@zax/fallout2";
import { PREVIEW_INSTALL, previewPlatform } from "./host.js";
import { store, unwrapArguments } from "./store.svelte.js";
import { BACKEND_METHODS, type Backend } from "@zax/fallout2";
import fallout2cfg from "../../../../fixtures/vanilla-f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/vanilla-f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/vanilla-f2up/ddraw.ini?raw";

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

const ORDER_FILE = `${PREVIEW_INSTALL}/mods/mods_order.txt`;
/** Captured on the first run, before any test has written to it, so the seed is not repeated here to drift. */
let seededOrder: Uint8Array | null = null;

beforeEach(async () => {
  const seeded = `games:\n- path: ${PREVIEW_INSTALL}\ntheme: system\n`;
  await previewPlatform.fs.write("preview/config/zax.yml", new TextEncoder().encode(seeded));
  // The config files too: a test that saves rewrites them, and the next test would inherit that.
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fallout2.cfg`, bytes(fallout2cfg));
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/f2_res.ini`, bytes(f2resini));
  await previewPlatform.fs.write(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(ddrawini));
  seededOrder ??= await previewPlatform.fs.read(ORDER_FILE);
  await previewPlatform.fs.write(ORDER_FILE, seededOrder);
  await store.start();
});

test("starts on the seeded install with its config files read", () => {
  expect(store.installs.map((one) => one.path)).toEqual([PREVIEW_INSTALL]);
  // Read from the fixture rather than defaulted: everything below distinguishes a value from its absence.
  expect(store.baselineOf("sfall.misc.processoridle")).toBe("-1");
  expect(store.baselineOf("hires.other-settings.cpu-usage-fix")).toBe("0");
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
    expect(store.results.every((r) => `${r.def.label} ${r.def.key} ${r.where}`.toLowerCase().includes("sound"))).toBe(
      true,
    );
    store.query = "";
  });

  test("reaches settings on tabs other than the one on screen", () => {
    store.settingsTab = "fallout2.cfg";
    store.query = "worldmap";
    // Every match here lives in ddraw.ini, which is a different tab from the one selected.
    const files = new Set(store.results.map((r) => r.def.file));
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
    expect(store.results.map((r) => r.def.id)).not.toContain("game.system.free-space");

    // A pinned value is drawn even where the layout hides it, so it stays findable.
    store.query = "uac";
    expect(store.results.map((r) => r.def.id)).toContain("hires.main.uac-aware");
    store.query = "";
  });

  test("finds a setting by one of its choice option labels", () => {
    // "DirectX9" appears only as an option label of the graphics mode choice - its label, key and address say
    // nothing about DirectX - so this passes only while option labels are part of the searched text.
    store.query = "directx9";
    expect(store.results.map((r) => r.def.id)).toContain("hires.main.graphics-mode");
    store.query = "";
  });

  test("going to a result selects the tab it lives on and drops the query", () => {
    store.query = "worldmap";
    const first = store.results[0]!;
    store.goTo(first.place);
    expect(store.settingsTab).toBe(first.place.file);
    expect(store.fileTab[first.place.file]).toBe(first.place.tab);
    expect(store.query, "leaving the query would send the user straight back to the results").toBe("");
  });
});

describe("gates", () => {
  const def = (id: string) => SETTINGS.find((s) => s.id === id)!;

  test("a gate on a key binding opens only once a key is actually bound", () => {
    store.revertAll();
    // The fixture never writes the binding, so the gate starts closed on an absent value rather than on a
    // listed one - the case a values-list gate could not express at all.
    expect(store.gateOf(def("sfall.input.fastmovefromcontainer"))?.active).toBe(false);

    store.set("sfall.input.itemfastmovekey", "30");
    expect(store.gateOf(def("sfall.input.fastmovefromcontainer"))?.active).toBe(true);

    store.set("sfall.input.itemfastmovekey", "0");
    expect(store.gateOf(def("sfall.input.fastmovefromcontainer"))?.active).toBe(false);
    store.revertAll();
  });

  test("the merged resolution keys carry the gate the pair control has to render", () => {
    store.revertAll();
    // The pair renders one control over two keys, so it reads the gate off a member rather than off itself.
    expect(store.gateOf(def("sfall.graphics.graphicswidth"))?.active).toBe(false);
    store.set("sfall.graphics.mode", "4");
    expect(store.gateOf(def("sfall.graphics.graphicswidth"))?.active).toBe(true);
    store.revertAll();
  });
});

describe("conflicts", () => {
  const fix = () => SETTINGS.find((s) => s.id === "hires.other-settings.cpu-usage-fix")!;

  test("stays quiet until both settings are in the states that clash", () => {
    store.revertAll();
    // The fixture ships both off: CPU_USAGE_FIX=0 and ProcessorIdle=-1.
    expect(store.conflictOf(fix())).toBeNull();

    store.set("hires.other-settings.cpu-usage-fix", "1");
    expect(store.conflictOf(fix()), "one side alone is not a clash").toBeNull();

    store.set("sfall.misc.processoridle", "0");
    expect(store.conflictOf(fix())?.other.id).toBe("sfall.misc.processoridle");

    // Backing either side out clears it again.
    store.set("sfall.misc.processoridle", "-1");
    expect(store.conflictOf(fix())).toBeNull();
    store.revertAll();
  });

  test("warns on both halves, not only the one carrying the declaration", () => {
    store.revertAll();
    const idle = SETTINGS.find((s) => s.id === "sfall.misc.processoridle")!;
    expect(idle.conflictsWith, "the declaration sits on the other half").toBeUndefined();

    store.set("hires.other-settings.cpu-usage-fix", "1");
    store.set("sfall.misc.processoridle", "0");
    // Someone who reaches this setting first would otherwise flip it with no warning at all.
    expect(store.conflictOf(idle)?.other.id).toBe("hires.other-settings.cpu-usage-fix");
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
      "-barter_prices.dat",
    ]);
    // The kinds are what makes a row's badge honest: a folder is not an archive, and an entry pointing at
    // nothing is neither.
    expect(store.mods.map((mod) => mod.kind)).toEqual(["dat", "dat", "folder", "missing", "dat"]);
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
        "weapon_sounds.dat\nextra_music.dat\nhero_appearance\nold_patch.dat\n; barter_prices.dat\n",
    );
  });

  test("forgetting a missing entry is the one thing that deletes a line", async () => {
    store.forgetMod("old_patch.dat");
    await store.save();

    expect(await order()).not.toContain("old_patch.dat");
    expect(shown()).not.toContain("+old_patch.dat");
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
  const PINNED = "hires.main.uac-aware";
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
    expect(store.modifiedInFile("fallout2.cfg"), "and the tab under it is marked too").toBe(1);

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
