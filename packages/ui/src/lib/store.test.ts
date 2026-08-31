import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { INSTALL_MARKER, ownTarget } from "@zax/core";
import {
  BACKEND_METHODS,
  SETTINGS,
  loadRecord,
  saveRecord,
  type Backend,
  type InstalledEngine,
  type ModFeedListing,
  type ModInstallState,
  type SfallUpdate,
} from "@zax/fallout2";
import { backend as hostBackend, busySink } from "./host.js";
import { PREVIEW_INSTALL, previewPlatform } from "./preview-host.js";
import { MOD_INI, ORDER_FILE, bytes, reseedPreview } from "./preview-fixture.js";
import { store, unwrapArguments } from "./store.svelte.js";
import fallout2cfg from "../../../../fixtures/f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/f2up/ddraw.ini?raw";

const ADDED_INSTALL = "preview/added";

// Shared with the component tests rather than kept here: both suites drive the same singleton over the same
// in-memory disk, and a second copy of the seed is a second thing to keep in step with the fixture.
beforeEach(reseedPreview);

test("starts on the seeded install with its config files read", () => {
  expect(store.installs.map((one) => one.path)).toEqual([PREVIEW_INSTALL]);
  // Read from the fixture rather than defaulted: everything below distinguishes a value from its absence.
  expect(store.baselineOf("sfall.Misc.ProcessorIdle")).toBe("-1");
  expect(store.baselineOf("hires.OTHER_SETTINGS.CPU_USAGE_FIX")).toBe("0");
});

describe("a setting more than one engine carries", () => {
  // One case forces the record write to fail; without this its spy would outlive it into the rest of these.
  afterEach(() => vi.restoreAllMocks());

  const BARTER = "sfall.Interface.ExpandBarter";
  const read = async (name: string) =>
    new TextDecoder("latin1").decode(await previewPlatform.fs.read(`${PREVIEW_INSTALL}/${name}`));

  /**
   * An install whose engines have each written their own settings, which is what makes their keys writable.
   * Saving by hand, which is the form most of these are about: the two autosave cases turn it back on.
   */
  const withEngines = async () => {
    await previewPlatform.fs.write(
      `${PREVIEW_INSTALL}/fallout2.cfg`,
      bytes(`${fallout2cfg}\n[ui]\nextend_ap_bar=0\nexpand_barter_window=0\n`),
    );
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=0\n"));
    await store.setAutosave(false);
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
    expect(store.reconciled[BARTER]?.from, "the row has to be able to say where it came from").toBe("fission.cfg");
    expect(store.notice?.kind).toBe("note");
  });

  test("writes the carry instead of queueing it when autosave is on, since there is no Save to press", async () => {
    // Autosave disables Save and draws no revert control, so the pending form left the user a banner asking
    // for both and no way to do either - and every mod flow refused to run while it stood.
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await store.setAutosave(true);
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await store.start();

    expect(store.valueOf(BARTER), "the newer value won, as it does either way").toBe("1");
    expect(store.isModified(BARTER), "and reached the files rather than the Save button").toBe(false);
    expect(store.modifiedCount, "so the bar has nothing to report as unsaved").toBe(0);
    expect(await read("ddraw.ini")).toContain("ExpandBarter=1");
    expect(store.notice?.text, "the banner says what happened rather than asking for a save").toBe(
      "One setting was changed outside ZAX and carried across to the other engines.",
    );
  });

  test("queues the carry after all when autosave cannot write it, rather than losing it", async () => {
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await store.setAutosave(true);
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    vi.spyOn(hostBackend, "saveConfigFiles").mockResolvedValue({ ok: false, changed: ["ddraw.ini"] });
    await store.start();

    expect(store.isModified(BARTER), "still pending, which is what the banner then describes").toBe(true);
    expect(store.notice?.text).toContain("Save to keep them, or revert.");
  });

  test("leaves a reverted carry alone on every later read of the install", async () => {
    // Reverting used to drop the pending edit and nothing else, so the next read of this install weighed the
    // same files against the same bases and carried the same value across again - on every switch of game.
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await store.start();
    expect(store.notice?.kind, "the carry was raised to begin with").toBe("note");

    await store.revertAll();
    expect(store.isModified(BARTER), "the carried edit is gone").toBe(false);
    expect(store.reconciled[BARTER], "and the row's note about where it came from with it").toBeUndefined();
    expect(store.notice, "and the banner that asked about it").toBeNull();

    await previewPlatform.fs.write(`${ADDED_INSTALL}/fallout2.exe`, new Uint8Array([0x4d, 0x5a]));
    await store.addInstall(ADDED_INSTALL);
    await store.selectInstall(ADDED_INSTALL);
    // What Dismiss does, so that anything showing afterwards is a banner the read back raised.
    store.notice = null;
    await store.selectInstall(PREVIEW_INSTALL);

    expect(store.notice, "the disagreement was accepted, so there is nothing left to raise").toBeNull();
    expect(store.isModified(BARTER)).toBe(false);
    expect(await read("fission.cfg"), "and no file was written to settle it").toContain("EnhancedBarter=1");
    expect(await read("ddraw.ini")).toContain("ExpandBarter=0");
  });

  test("says so when the revert could not be recorded, rather than looking settled until the next read", async () => {
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await store.start();
    vi.spyOn(hostBackend, "acceptSettingsBase").mockRejectedValue(new Error("the record is read-only"));

    await store.revertAll();

    expect(store.notice).toEqual({
      kind: "problem",
      text: "The revert could not be recorded: the record is read-only",
    });
    // Still true of the file, and the next read will carry it across again - so the row goes on saying it.
    expect(store.reconciled[BARTER]?.from).toBe("fission.cfg");
  });

  test("carries a further change inside an engine across, measured from the accepted base", async () => {
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await store.start();
    await store.revertAll();

    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=2\n"));
    await store.start();

    expect(store.valueOf(BARTER), "accepting one disagreement is not agreeing to the next").toBe("2");
    expect(store.reconciled[BARTER]?.from).toBe("fission.cfg");
  });

  test("asks rather than choosing when two engines have both moved", async () => {
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(`${ddrawini}\n[Interface]\nExpandBarter=2\n`));
    await store.start();

    expect(store.reconciled[BARTER], "no value was picked on the user's behalf").toBeUndefined();
    expect(store.settingsChoices.map((one) => one.id)).toContain(BARTER);
  });

  /** An install where both engines moved off what ZAX wrote, which is what raises the question. */
  const withBothMoved = async () => {
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=1\n"));
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(`${ddrawini}\n[Interface]\nExpandBarter=2\n`));
    await store.start();
  };

  test("stops asking once an answered choice has been reverted", async () => {
    // The carry's defect in the other affordance: answering left a pending edit and nothing else, so a revert
    // of that edit put the same question back on the next read of the install.
    await withBothMoved();
    store.chooseLinked(BARTER, "1");
    expect(store.isModified(BARTER)).toBe(true);

    await store.revertAll();
    await store.start();

    expect(
      store.settingsChoices.map((one) => one.id),
      "the question was answered and the answer undone",
    ).toEqual([]);
    expect(store.notice, "and nothing was carried across in its place either").toBeNull();
  });

  test("leaves an unanswered question standing through a revert", async () => {
    // A revert undoes what the user did. They have not answered this one, so there is nothing of theirs to
    // undo - and dismissing it here would decide on their behalf which of two values is lost.
    await withBothMoved();
    store.set("game.preferences.running", "1");

    await store.revertAll();

    expect(store.settingsChoices.map((one) => one.id)).toContain(BARTER);
  });

  test("answering with the value the setting's own address already holds still reaches the other engine", async () => {
    // The value shown comes from ddraw.ini alone. Picking it looks like picking what is already there, and
    // used to be dropped as no edit at all - leaving Save disabled and the question to be asked again.
    await withBothMoved();
    expect(store.valueOf(BARTER), "what the control was showing").toBe("2");

    store.chooseLinked(BARTER, "2");
    expect(store.isModified(BARTER), "fission.cfg still holds something else, so there is an edit").toBe(true);
    expect(store.modifiedCount).toBe(1);
    await store.save();

    expect(await read("fission.cfg"), "the engine that lagged was brought into line").toContain("EnhancedBarter=2");
    expect(await read("ddraw.ini")).toContain("ExpandBarter=2");
    expect(store.settingsChoices, "and the question is settled for good").toEqual([]);
  });

  test("marks a carried row modified even where the address that moved is the one on screen", async () => {
    // ddraw.ini is the setting's own address, so the carried value equals what the control shows. The row
    // was left unmarked and without its revert button while telling the user to save or revert.
    await withEngines();
    store.set(BARTER, "0");
    await store.save();
    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/ddraw.ini`, bytes(`${ddrawini}\n[Interface]\nExpandBarter=1\n`));
    await store.start();

    expect(store.reconciled[BARTER]?.from, "ddraw.ini is the one that moved").toBe("ddraw.ini");
    expect(store.valueOf(BARTER), "which is also the value the control shows").toBe("1");
    expect(store.isModified(BARTER), "so the row has to be marked, and offer its revert").toBe(true);
  });

  test("asks again when an engine moves once more after an answer was reverted", async () => {
    await withBothMoved();
    store.chooseLinked(BARTER, "1");
    await store.revertAll();

    await previewPlatform.fs.write(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\nEnhancedBarter=3\n"));
    await store.start();

    expect(store.valueOf(BARTER), "one address moved off its accepted base, so it is carried").toBe("3");
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

test("opens the Add game picker on the executable that decides whether a folder is an install", async () => {
  // Same reasoning as the mod questions: a folder picker shows no files, and every install ZAX recognises is
  // one holding fallout2.exe - so the folder around that file cannot then be refused for lacking it.
  const picker = vi.spyOn(hostBackend, "chooseFolder").mockResolvedValue(null);

  await store.browseForInstall();

  expect(picker).toHaveBeenCalledWith(INSTALL_MARKER);
  vi.restoreAllMocks();
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

  test("a gate on a key binding opens only once a key is actually bound", async () => {
    await store.revertAll();
    // The fixture never writes the binding, so the gate starts closed on an absent value rather than on a
    // listed one - the case a values-list gate could not express at all.
    expect(store.gateOf(def("sfall.Input.FastMoveFromContainer"))?.active).toBe(false);

    store.set("sfall.Input.ItemFastMoveKey", "30");
    expect(store.gateOf(def("sfall.Input.FastMoveFromContainer"))?.active).toBe(true);

    store.set("sfall.Input.ItemFastMoveKey", "0");
    expect(store.gateOf(def("sfall.Input.FastMoveFromContainer"))?.active).toBe(false);
    await store.revertAll();
  });

  test("the merged resolution keys carry the gate the pair control has to render", async () => {
    await store.revertAll();
    // The pair renders one control over two keys, so it reads the gate off a member rather than off itself.
    expect(store.gateOf(def("sfall.Graphics.GraphicsWidth"))?.active).toBe(false);
    store.set("sfall.Graphics.Mode", "4");
    expect(store.gateOf(def("sfall.Graphics.GraphicsWidth"))?.active).toBe(true);
    await store.revertAll();
  });
});

describe("conflicts", () => {
  const fix = () => SETTINGS.find((s) => s.id === "hires.OTHER_SETTINGS.CPU_USAGE_FIX")!;

  test("stays quiet until both settings are in the states that clash", async () => {
    await store.revertAll();
    // The fixture ships both off: CPU_USAGE_FIX=0 and ProcessorIdle=-1.
    expect(store.conflictOf(fix())).toBeNull();

    store.set("hires.OTHER_SETTINGS.CPU_USAGE_FIX", "1");
    expect(store.conflictOf(fix()), "one side alone is not a clash").toBeNull();

    store.set("sfall.Misc.ProcessorIdle", "0");
    expect(store.conflictOf(fix())?.other.id).toBe("sfall.Misc.ProcessorIdle");

    // Backing either side out clears it again.
    store.set("sfall.Misc.ProcessorIdle", "-1");
    expect(store.conflictOf(fix())).toBeNull();
    await store.revertAll();
  });

  test("warns on both halves, not only the one carrying the declaration", async () => {
    await store.revertAll();
    const idle = SETTINGS.find((s) => s.id === "sfall.Misc.ProcessorIdle")!;
    expect(idle.conflictsWith, "the declaration sits on the other half").toBeUndefined();

    store.set("hires.OTHER_SETTINGS.CPU_USAGE_FIX", "1");
    store.set("sfall.Misc.ProcessorIdle", "0");
    // Someone who reaches this setting first would otherwise flip it with no warning at all.
    expect(store.conflictOf(idle)?.other.id).toBe("hires.OTHER_SETTINGS.CPU_USAGE_FIX");
    await store.revertAll();
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

  test("copies nothing aside, through the same path the window saves by", async () => {
    // Installing a mod backs up into the same directory, so the ground is cleared first and anything there
    // afterwards belongs to this save. The write is asserted too, or a save that did nothing would pass.
    await previewPlatform.fs.remove(store.paths.backup);
    store.set(MUSIC, "0");
    await store.save();

    const onDisk = new TextDecoder("latin1").decode(await previewPlatform.fs.read(`${PREVIEW_INSTALL}/fallout2.cfg`));
    expect(onDisk).not.toBe(fallout2cfg);
    expect(await previewPlatform.fs.stat(store.paths.backup)).toBeNull();
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

  test("reverting restores the order as it was read", async () => {
    store.toggleMod("hero_appearance");
    store.moveMod("hero_appearance", -1);
    await store.revertAll();
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
      BACKEND_METHODS.map((name) => [
        name,
        async (...args: unknown[]) => {
          seen.push(args);
          return Promise.resolve(undefined);
        },
      ]),
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

  test("the settings mark appears on an edit and clears on revert, in step with the file tab's dot", async () => {
    expect(store.settingsChanged, "a fresh install carries ZAX's pinned values and no edit").toBe(false);

    store.set(MUSIC, store.baselineOf(MUSIC) === "1" ? "0" : "1");

    expect(store.settingsChanged).toBe(true);
    expect(store.modifiedInGroup("fallout2.cfg"), "and the tab under it is marked too").toBe(1);

    await store.revert(MUSIC);
    expect(store.settingsChanged).toBe(false);
  });

  test("neither mark answers for the other's view", async () => {
    store.moveMod("hero_appearance", -1);
    expect(store.modsChanged).toBe(true);
    expect(store.settingsChanged, "a mod that moved is not a settings edit").toBe(false);

    store.set(MUSIC, store.baselineOf(MUSIC) === "1" ? "0" : "1");
    await store.revertAll();
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
  const settle = async () => new Promise((resolve) => setTimeout(resolve, 900));

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

  test("is on unless the user has turned it off, which is what a fresh state file reads as", () => {
    expect(store.autosave).toBe(true);
  });
});

describe("a long operation", () => {
  test("reports its step and proportion while it runs, and nothing once it has stopped", async () => {
    expect(store.progressParts, "nothing is running").toBeNull();

    // What the backend reports as a download advances. Delivered through the same subscription the desktop
    // build uses - the preview builds one over its own in-process backend.
    store.busy = "Updating sfall";
    store.progress = { step: "Downloading sfall 4.5", received: 440_000, total: 880_000 };
    expect(store.progressParts).toEqual({ step: "Downloading sfall 4.5", amount: "50% of 0.8 MB" });

    // A step with no length says what it is doing and claims no proportion it cannot know.
    store.progress = { step: "Merging your settings" };
    expect(store.progressParts).toEqual({ step: "Merging your settings", amount: null });

    store.busy = null;
    store.progress = null;
    expect(store.progressParts).toBeNull();
  });

  describe("what the shell is told about it", () => {
    afterEach(() => vi.restoreAllMocks());

    // Held open rather than awaited to the end: what the desktop window reads is the state during the
    // operation, and a test that only ever sees the settled state would stay green if the report moved after
    // the work it is about.
    const heldScan = () => {
      let finish = () => {};
      vi.spyOn(hostBackend, "scanForInstalls").mockImplementation(
        async () =>
          new Promise((resolve) => {
            finish = () => resolve([]);
          }),
      );
      return () => finish();
    };

    test("names the operation while it runs, and takes it back once it has stopped", async () => {
      const told = vi.spyOn(busySink, "set");
      const finish = heldScan();

      // Taken while it runs and asserted after: the store is a singleton these tests share, and an assertion
      // that threw before the operation was let go would leave it busy for every test after this one.
      const scanning = store.scan();
      const midFlight = [...told.mock.calls];
      finish();
      await scanning;

      expect(midFlight, "the window has nothing else to ask about").toEqual([["Scanning"]]);
      expect(told.mock.calls).toEqual([["Scanning"], [null]]);
    });

    test("takes it back when the operation fails, which is where a window could be left unclosable", async () => {
      const told = vi.spyOn(busySink, "set");
      vi.spyOn(hostBackend, "scanForInstalls").mockRejectedValue(new Error("nothing to scan"));

      await store.scan();

      expect(store.notice?.kind, "the failure is still the user's to read").toBe("problem");
      expect(told.mock.calls).toEqual([["Scanning"], [null]]);
    });
  });

  test("says a second request was refused rather than dropping it in silence", async () => {
    // A click during an update used to do nothing at all, which reads as a broken button rather than a busy
    // application - and these operations run for minutes on a poor connection.
    store.busy = "Updating sfall";
    await store.scan();

    expect(store.notice).toEqual({ kind: "problem", text: "Updating sfall is still running - wait for it to finish." });
    store.busy = null;
  });

  describe("stopping it", () => {
    afterEach(() => {
      store.busy = null;
      store.progress = null;
      store.cancelling = false;
      vi.restoreAllMocks();
    });

    /** An operation the test resolves by hand, so the state during it is what gets asserted. */
    const held = () => {
      let settle: (error?: Error) => void = () => {};
      vi.spyOn(hostBackend, "scanForInstalls").mockImplementation(
        async () =>
          new Promise((resolve, reject) => {
            settle = (error) => (error ? reject(error) : resolve([]));
          }),
      );
      return (error?: Error) => settle(error);
    };

    /*
      Read from what the backend declares about the running step, not from the byte counts being there. Only the
      transfer honours a cancel, and a button offered over a step that would ignore it is worse than no button.
    */
    test("is offered only where the running step says a cancel would reach it", () => {
      expect(store.cancellable, "nothing is running").toBe(false);

      store.busy = "Installing Restoration Project Updated";
      store.progress = { step: "Downloading Restoration Project Updated", received: 1, total: 10, cancellable: true };
      expect(store.cancellable).toBe(true);

      // Past the transfer: the same operation, still running, no longer stoppable.
      store.progress = { step: "Installing the files", cancellable: false };
      expect(store.cancellable).toBe(false);
    });

    test("stops offering itself once it has been asked for", async () => {
      const settle = held();
      const asked = vi.spyOn(hostBackend, "cancel");
      const scanning = store.scan();
      store.progress = { step: "Downloading", received: 1, total: 10, cancellable: true };

      await store.cancel();
      expect(asked).toHaveBeenCalledTimes(1);
      expect(store.cancelling).toBe(true);
      expect(store.cancellable, "the button goes rather than being pressed twice").toBe(false);

      // A second press reaches nothing, which is what stops two cancels racing one operation.
      await store.cancel();
      expect(asked).toHaveBeenCalledTimes(1);

      settle(new Error("Cancelled."));
      await scanning;
    });

    /*
      The point of the flag. What comes back has crossed a process boundary that keeps the message and drops the
      type, so the only side that still knows this was asked for is the side that asked - without it a cancel
      reads to the user as the operation having broken.
    */
    test("reports a stopped operation as stopped, not as a failure", async () => {
      const settle = held();
      const scanning = store.scan();
      store.progress = { step: "Downloading", received: 1, total: 10, cancellable: true };
      await store.cancel();

      settle(new Error("Cancelled."));
      await scanning;

      expect(store.notice?.kind, "not a fault the user should go looking into").toBe("note");
      expect(store.notice?.text).toBe("Scanning was stopped. What had been downloaded is kept.");
      expect(store.cancelling, "and the next operation starts clean").toBe(false);
    });

    test("still reports a genuine failure as one", async () => {
      const settle = held();
      const scanning = store.scan();

      settle(new Error("nothing to scan"));
      await scanning;

      expect(store.notice?.kind).toBe("problem");
      expect(store.notice?.text).toBe("Scanning failed: nothing to scan");
    });

    /*
      What every control that is greyed out shows. A button that will not answer and says nothing reads as
      broken rather than as busy, which is the whole complaint this exists to answer.
    */
    test("says why the controls are refused, in a sentence, and nothing when they are not", () => {
      expect(store.busyReason, "nothing is running").toBeNull();

      store.busy = "Installing Restoration Project Updated";
      expect(store.busyReason).toBe("Installing Restoration Project Updated is running.");

      store.cancelling = true;
      expect(store.busyReason, "and it changes once stopping is under way").toBe(
        "Stopping Installing Restoration Project Updated.",
      );
    });
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
    await store.revert("fo2tweaks.main.autodoors");
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
    await store.revert("fo2tweaks.main.autodoors");
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

  /*
    The floor is a base mod's alone: its installer cannot go back down. A mod that is files in the mods folder
    is replaced by an older release the same way it is by a newer one, so its list is asked for unfloored.
  */
  test("asks without a floor for a mod that is not a base one, so older releases are offered", async () => {
    const versions = vi.spyOn(hostBackend, "modVersions").mockResolvedValue(["14.8", "14.7", "14.6"]);
    await store.chooseModVersion({
      id: "fo2tweaks",
      name: "FO2tweaks",
      version: "14.8",
      type: "pluggable",
      availability: { kind: "downgrade", from: "15.0" },
    });
    expect(versions).toHaveBeenCalledWith("fo2tweaks", undefined);
  });

  /* A conversion states what is on disk separately: the offered release's type is the one it would become. */
  test("floors on the type that is installed, not the one being offered", async () => {
    const versions = vi.spyOn(hostBackend, "modVersions").mockResolvedValue(["2.3.34"]);
    await store.chooseModVersion({
      ...offer,
      type: "pluggable",
      availability: { kind: "convert", from: "2.3.32", was: "base" },
    });
    expect(versions).toHaveBeenCalledWith("rpu23", "2.3.32");
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

  /** The dialog as it stands when the et tu install is confirmed, which is what the outcome answers. */
  const holdEtTu = () => {
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
  };

  test("adds a second game when the mod creates one beside this install", async () => {
    const created = `${PREVIEW_INSTALL}/Fallout1in2`;
    answering({ version: "1.16.3771", created, extracted: 8602, conflicts: [] }, "fo1in2");

    holdEtTu();
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

  test("names the paths the user's own archive did not hold, while a reader can still read them", async () => {
    const created = `${PREVIEW_INSTALL}/Fallout1in2`;
    const skipped = ["SOUND/SPEECH/LIEUT/LI3ACD~5.TXT", "SOUND/SPEECH/LIEUT/LI3ACF~5.TXT"];
    answering({ version: "1.16.3771", created, extracted: 8600, skipped, conflicts: [] }, "fo1in2");

    holdEtTu();
    await store.confirmModInstall();

    expect(store.notice?.text).toContain(`Your archive does not hold ${skipped.join(", ")}, so they were skipped.`);
  });

  test("counts them instead once there are more than a banner can carry", async () => {
    // A Fallout 1 copy an edition apart renumbers its 8.3 collision suffixes, so the extraction can go
    // around hundreds of paths. Naming every one of them reports nothing and buries the rest of the line.
    const created = `${PREVIEW_INSTALL}/Fallout1in2`;
    const skipped = Array.from({ length: 176 }, (_, i) => `SOUND/SPEECH/A${i}~1.TXT`);
    answering({ version: "1.16.3771", created, extracted: 8426, skipped, conflicts: [] }, "fo1in2");

    holdEtTu();
    await store.confirmModInstall();

    expect(store.notice?.text).toContain("Your archive does not hold 176 of the files the mod asked for");
    expect(store.notice?.text, "and not the list itself").not.toContain("SOUND/SPEECH/A0~1.TXT");
  });
});

describe("engines", () => {
  afterEach(() => vi.restoreAllMocks());

  const launching = () => vi.spyOn(hostBackend, "launch").mockResolvedValue(undefined as never);

  test("Run starts the game on its own executable", async () => {
    const launch = launching();
    await store.play();
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ path: PREVIEW_INSTALL }), null, null, null);
  });

  test("Run in CE starts it through the engine, following whatever the folder holds", async () => {
    const launch = launching();
    await store.play("fallout2-ce");
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ path: PREVIEW_INSTALL }), null, "fallout2-ce", null);
  });

  test("runs the build the caller names rather than the newest", async () => {
    const launch = launching();
    await store.play("fallout2-ce", "2026-07-01T00:00:00Z");
    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ path: PREVIEW_INSTALL }),
      null,
      "fallout2-ce",
      "2026-07-01T00:00:00Z",
    );
  });

  test("keeps a check across installs, and re-reads what is deployed in the one arrived at", async () => {
    // selectInstall is a no-op on the already-selected path (it would otherwise drop unsaved edits on a
    // re-click), so leaving has to mean an actual other install, not PREVIEW_INSTALL a second time.
    const deployed = vi.spyOn(hostBackend, "deployedEngines").mockResolvedValue([]);
    store.installs = [...store.installs, { path: "/games/other", type: "fallout2" }];
    const published = { release: "continious", published: "2026-08-23T09:37:22Z", asset: null, commit: null };
    store.engineLatest = { "fallout2-ce": published };
    await store.selectInstall("/games/other");
    // The project published one release, not one per game folder, so the check outlives the switch.
    expect(store.engineLatest).toEqual({ "fallout2-ce": published });
    // What is the folder's - which build is deployed in it - is read again for the one arrived at.
    expect(deployed).toHaveBeenCalledWith(expect.objectContaining({ path: "/games/other" }));
    expect(store.engineDeployed).toEqual({});
  });

  /*
    Run is drawn unconditionally and each Run in X off this listing, so rereading it for the length of an
    install's reads took the engine's button away and put it back on every switch, over a fact that had not
    moved. Now the listing is the machine's and the switch cannot touch it at all - asserted by identity, which
    is stronger than the old check that it merely stayed non-empty.
  */
  test("leaves the machine listing untouched across an install switch", async () => {
    const before = store.engines;
    expect(before.length, "the preview seeds builds, or this asserts nothing").toBeGreaterThan(0);

    const machine = vi.spyOn(hostBackend, "machineEngines");
    store.installs = [...store.installs, { path: "/games/other", type: "fallout2" }];
    await store.selectInstall("/games/other");
    await store.selectInstall(PREVIEW_INSTALL);

    expect(store.engines).toBe(before);
    expect(machine, "switching folders is not a reason to ask the machine anything").not.toHaveBeenCalled();
  });

  test("holds the machine's builds for a folder that has never run the engine", () => {
    expect(store.engineVersions("fallout2-ce").map((one) => one.published)).toEqual([
      "2026-08-23T09:37:22Z",
      "2026-07-01T00:00:00Z",
    ]);
    expect(store.engineDeployed["fallout2-ce"], "nothing is deployed in the preview folder").toBeUndefined();
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

  /** What this folder has deployed. A tab is offered for an engine that has run here, not one merely cached. */
  const listing = (...installed: string[]) =>
    vi.spyOn(hostBackend, "deployedEngines").mockResolvedValue(installed.map(deployed));

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
    vi.spyOn(hostBackend, "deployedEngines").mockResolvedValue([
      { id: "fission", release: "continious", published: "2026-08-23T09:37:22Z", complete: true, files: [] },
    ]);
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
    vi.spyOn(hostBackend, "deployedEngines").mockResolvedValue([
      { id: "fission", release: "continious", published: "2026-08-23T09:37:22Z", complete: true, files: [] },
    ]);
    await store.start();
    expect(store.linkedTo(def, "ddraw.ini")).toEqual([
      { at: expect.objectContaining({ file: "fission.cfg" }), live: false },
    ]);
  });

  test("marks nothing on an install carrying no alternative engine", async () => {
    vi.spyOn(hostBackend, "deployedEngines").mockResolvedValue([]);
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
    return vi.spyOn(hostBackend, "engineReleases").mockResolvedValue([published]);
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

  test("are read before the standing on the first reading, so both halves describe one set of releases", async () => {
    // Where an install stands is decided against the releases the backend is holding, so a read that
    // replaces them has to land first. Started the other way round, the two halves could describe different
    // sets - and `listingFrom` drops a mod published by one and unknown to the other without a word, which
    // is a row that vanishes until Refresh happens to read both again.
    const order: string[] = [];
    let answerFeeds!: () => void;
    const held = new Promise<void>((resolve) => (answerFeeds = resolve));
    vi.spyOn(hostBackend, "publishedMods").mockImplementation(async () => {
      order.push("feeds");
      await held;
      return feeds;
    });
    vi.spyOn(hostBackend, "modInstallState").mockImplementation(async () => {
      order.push("standing");
      return standingOf("mine");
    });

    // Neither half read yet, which is the state a launch starts in.
    store.modFeeds = null;
    store.installs = [...store.installs, other];
    await store.selectInstall(other.path);

    await vi.waitFor(() => expect(order).toEqual(["feeds"]));
    expect(order, "the standing may not be asked while the feeds are still out").toEqual(["feeds"]);
    answerFeeds();
    await vi.waitFor(() => expect(order).toEqual(["feeds", "standing"]));
  });

  test("are asked again by the next reading of an install when the first attempt failed", async () => {
    // The read is quiet, so a feed that was unreachable on the first attempt left the tab saying the feeds
    // had never been read - with nothing to retry it but a change of game or Refresh.
    const asked = vi
      .spyOn(hostBackend, "publishedMods")
      .mockRejectedValueOnce(new Error("the machine was offline"))
      .mockResolvedValue(feeds);
    vi.spyOn(hostBackend, "modInstallState").mockResolvedValue(standingOf("mine"));

    store.modFeeds = null;
    store.installs = [...store.installs, other];
    await store.selectInstall(other.path);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    expect(store.modFeeds, "the attempt failed, and quietly").toBeNull();

    // Saving rereads the install. It is not a change of game, which is what used to be asked here.
    await store.save();

    await vi.waitFor(() => expect(store.modListing?.offers).toEqual(offersFor("mine")));
  });

  test("are not asked a second time while the first attempt is still out", async () => {
    let answerFeeds!: () => void;
    const held = new Promise<void>((resolve) => (answerFeeds = resolve));
    const asked = vi.spyOn(hostBackend, "publishedMods").mockImplementation(async () => {
      await held;
      return feeds;
    });
    vi.spyOn(hostBackend, "modInstallState").mockResolvedValue(standingOf("mine"));

    store.modFeeds = null;
    store.installs = [...store.installs, other];
    await store.selectInstall(other.path);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledTimes(1));
    await store.save();

    expect(asked, "the retry above must not fire on a read that has not answered yet").toHaveBeenCalledTimes(1);
    answerFeeds();
    await vi.waitFor(() => expect(store.modListing?.offers).toEqual(offersFor("mine")));
  });

  test("leave the tab unsettled, with the reason, until the reading its rows describe has landed", async () => {
    const answered = published();
    vi.spyOn(hostBackend, "modInstallState").mockResolvedValue(standingOf("mine"));
    await store.loadModOffers();
    expect(store.modsSettled, "both halves in, for this game, with nothing out").toBe(true);
    expect(store.modsUnsettled, "nothing to explain while they agree").toBeNull();

    // The moment a change of game opens: the rows on screen are the game left behind, and an install fired
    // at them would act on a folder the row never described.
    store.installs = [...store.installs, other];
    store.selectedInstall = other.path;
    expect(store.modsSettled).toBe(false);
    expect(store.modsUnsettled).toBe(
      "Reading this game's folder. Until it answers, the rows below are the game you were on.",
    );

    expect(answered).toHaveBeenCalled();
  });

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

  test("the game's own half lands with the rest of the reading, not on its own", async () => {
    published();
    // Held open so the switch is still out while the tab is on screen, which is the state it has to describe.
    let release = (): void => {};
    const held = new Promise<ModInstallState>((resolve) => {
      release = () => resolve(standingOf("theirs"));
    });
    const asked = vi
      .spyOn(hostBackend, "modInstallState")
      .mockImplementation(async (install) =>
        install.path === other.path ? held : Promise.resolve(standingOf("mine")),
      );
    store.installs = [...store.installs, other];
    await store.loadModOffers();
    expect(store.modListing?.offers).toEqual(offersFor("mine"));

    const switching = store.selectInstall(other.path);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledWith(expect.objectContaining({ path: other.path })));
    // Neither blanked nor half-replaced. Emptied on the first line of the switch, the tab threw its table away
    // and said it was reading, for the length of a read of the folder it already had the answer for.
    expect(store.modListing?.offers, "the game left behind, whole").toEqual(offersFor("mine"));
    // Off the `busy` gate: a read nobody asked for must not grey out the controls.
    expect(store.busy).toBeNull();

    release();
    await switching;
    expect(store.modListing?.offers, "and the game arrived at, whole").toEqual(offersFor("theirs"));
  });

  test("refuses a mod flow started against rows the switch has not caught up with", async () => {
    published();
    let release = (): void => {};
    const held = new Promise<ModInstallState>((resolve) => {
      release = () => resolve(standingOf("theirs"));
    });
    const asked = vi
      .spyOn(hostBackend, "modInstallState")
      .mockImplementation(async (install) =>
        install.path === other.path ? held : Promise.resolve(standingOf("mine")),
      );
    const planned = vi.spyOn(hostBackend, "planMod");
    store.installs = [...store.installs, other];
    await store.loadModOffers();
    const [onScreen] = store.modListing?.offers ?? [];
    if (!onScreen) throw new Error("the tab drew no row for the game we start on, so there is nothing to click");

    const switching = store.selectInstall(other.path);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledWith(expect.objectContaining({ path: other.path })));
    // The row describes the folder it was read for, and the flow would act on the one now selected.
    await store.prepareMod(onScreen);

    expect(planned).not.toHaveBeenCalled();
    expect(store.notice?.kind).toBe("problem");
    expect(store.notice?.text).toContain("still being read");

    release();
    await switching;
  });

  test("survive a reread of the same game, which is what saving and installing do", async () => {
    published();
    vi.spyOn(hostBackend, "modInstallState").mockResolvedValue(standingOf("read-once"));
    await store.loadModOffers();
    expect(store.modListing?.offers).toEqual(offersFor("read-once"));

    // Installing an engine rereads the install. Nothing about which mods are on offer changed, and blanking
    // the tab back to unread over it is the bug this pins.
    vi.spyOn(hostBackend, "fetchEngine").mockResolvedValue({
      release: "continious",
      published: "2026-08-23T09:37:22Z",
      asset: null,
      commit: null,
    });
    await store.fetchEngine("fallout2-ce");

    expect(store.modListing?.offers, "the folder on screen is the one this was read for").toEqual(
      offersFor("read-once"),
    );
  });

  test("settle when a reread of the same game overtakes the switch's own reading", async () => {
    published();
    // Only the switch's own read is held. The reread that overtakes it answers at once, which is what makes
    // it the reading that publishes.
    let release = (): void => {};
    const held = new Promise<ModInstallState>((resolve) => {
      release = () => resolve(standingOf("overtaken"));
    });
    let outstanding = true;
    const asked = vi.spyOn(hostBackend, "modInstallState").mockImplementation(async (install) => {
      if (install.path !== other.path) return Promise.resolve(standingOf("mine"));
      if (outstanding) {
        outstanding = false;
        return held;
      }
      return Promise.resolve(standingOf("theirs"));
    });
    store.installs = [...store.installs, other];
    await store.loadModOffers();

    const switching = store.selectInstall(other.path);
    await vi.waitFor(() => expect(asked).toHaveBeenCalledWith(expect.objectContaining({ path: other.path })));
    // A save inside the window the switch is open for - it holds no gate, so nothing refuses this. It reads
    // the same folder, and its reading is the one that lands: the switch's is dropped for being the older.
    await store.save();
    release();
    await switching;

    expect(store.modsUnsettled, "the folder has been read, so there is nothing left to explain").toBeNull();
    expect(store.modsSettled).toBe(true);
    expect(store.modListing?.offers).toEqual(offersFor("theirs"));
  });

  test("drop an answer that arrives for a game that is no longer the selected one", async () => {
    published();
    // Held open so the second switch is over while the first read is still out - the only way the two cross.
    let release = (): void => {};
    const held = new Promise<ModInstallState>((resolve) => {
      release = () => resolve(standingOf("stale"));
    });
    vi.spyOn(hostBackend, "modInstallState").mockImplementation(async (install) =>
      install.path === other.path ? held : Promise.resolve(standingOf("mine")),
    );
    store.installs = [...store.installs, other];
    // The game switched away from, read and on screen: the answer held below has to be dropped on top of
    // something known, or nothing distinguishes it landing from it being dropped.
    await store.loadModOffers();

    const switching = store.selectInstall(other.path);
    // Nothing is read for this one: its own standing is still the one on screen, the switch away never having
    // published. What the case is about is the held answer arriving after it.
    await store.selectInstall(PREVIEW_INSTALL);
    release();
    await switching;

    expect(store.modListing?.offers).toEqual(offersFor("mine"));
  });
});

describe("one reading of an install, published whole", () => {
  afterEach(() => vi.restoreAllMocks());

  const other = { path: "/games/other", type: "fallout2" } as const;
  /** Deployed in the game switched away from, so its tab is on screen for the length of the read. */
  const fission: InstalledEngine = {
    id: "fission",
    release: "v1.0",
    published: "2026-01-01T00:00:00Z",
    complete: true,
    files: ["fallout-fission-x64.exe"],
  };

  test("shows none of it until all of it has been read", async () => {
    store.installs = [...store.installs, other];
    vi.spyOn(hostBackend, "deployedEngines").mockResolvedValue([fission]);
    await store.selectInstall(other.path);
    expect(store.engineDeployed["fission"]).toBeDefined();
    const engines = store.engineDeployed;
    const contents = store.contents;

    // The last read of the switch, held open so the rest of it has answered while the switch is still out.
    let release = (): void => {};
    const held = new Promise<readonly InstalledEngine[]>((resolve) => {
      release = () => resolve([]);
    });
    const asked = vi.spyOn(hostBackend, "deployedEngines").mockReturnValue(held);

    const switching = store.selectInstall(PREVIEW_INSTALL);
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    // Assigned as each answer landed, these crossed over one at a time and the pane drew a mixture of two
    // games - an engine's tab blinking out on the first line of the read and back on its last.
    expect(store.engineDeployed, "the engines the pane draws tabs from").toBe(engines);
    expect(store.contents, "and the values under them").toBe(contents);

    release();
    await switching;
    expect(store.engineDeployed).toEqual({});
    expect(store.contents).not.toBe(contents);
  });

  test("drops a reading the user has already moved on from", async () => {
    store.installs = [...store.installs, other];
    // Held open so the second switch is over while the first read is still out - the only way the two cross.
    let release = (): void => {};
    const held = new Promise<readonly InstalledEngine[]>((resolve) => {
      release = () => resolve([fission]);
    });
    const asked = vi
      .spyOn(hostBackend, "deployedEngines")
      .mockImplementation(async (install) => (install.path === other.path ? held : Promise.resolve([])));

    const switching = store.selectInstall(other.path);
    await vi.waitFor(() => expect(asked).toHaveBeenCalled());
    await store.selectInstall(PREVIEW_INSTALL);
    release();
    await switching;

    expect(store.engineDeployed, "the game left behind may not land on top of the one selected").toEqual({});
  });
});

describe("changing which sfall an install has", () => {
  afterEach(() => vi.restoreAllMocks());

  const outcome = (over: Partial<SfallUpdate> = {}): SfallUpdate => ({
    version: "4.5",
    replaced: ["ddraw.dll"],
    backup: null,
    conflicts: [],
    removed: [],
    ...over,
  });

  test("names the version, and says nothing else when the update replaced nothing and merged cleanly", async () => {
    vi.spyOn(hostBackend, "updateSfall").mockResolvedValue(outcome());
    await store.changeSfall("4.5");
    expect(store.notice).toEqual({ kind: "done", text: "sfall is now 4.5." });
  });

  test("says where the replaced files went, so the user can find them without being told twice", async () => {
    vi.spyOn(hostBackend, "updateSfall").mockResolvedValue(outcome({ backup: "backup/2026-08-31" }));
    await store.changeSfall("4.5");
    expect(store.notice?.text).toBe("sfall is now 4.5. Replaced files are in backup/2026-08-31.");
  });

  test("names the settings the merge kept, rather than counting them", async () => {
    vi.spyOn(hostBackend, "updateSfall").mockResolvedValue(
      outcome({
        conflicts: [
          { section: "Misc", key: "DamageFormula", mine: "1", theirs: "0" },
          { section: "Input", key: "ItemFastMoveKey", mine: "30", theirs: "0" },
        ],
      }),
    );
    await store.changeSfall("4.5");
    expect(store.notice?.text).toBe("sfall is now 4.5. Kept your value for DamageFormula, ItemFastMoveKey.");
  });

  // The count is the plural's only input, so its two sides are the whole of what there is to get wrong.
  test("counts dropped settings in the singular for one", async () => {
    vi.spyOn(hostBackend, "updateSfall").mockResolvedValue(outcome({ removed: [{ section: "Misc", key: "Old" }] }));
    await store.changeSfall("4.5");
    expect(store.notice?.text).toBe("sfall is now 4.5. Dropped 1 setting this release does not have.");
  });

  test("and in the plural for more than one", async () => {
    vi.spyOn(hostBackend, "updateSfall").mockResolvedValue(
      outcome({
        removed: [
          { section: "Misc", key: "Old" },
          { section: "Misc", key: "Older" },
        ],
      }),
    );
    await store.changeSfall("4.5");
    expect(store.notice?.text).toBe("sfall is now 4.5. Dropped 2 settings this release does not have.");
  });

  test("carries the label the caller was doing, since going back is not updating", async () => {
    const held = vi.spyOn(hostBackend, "updateSfall").mockResolvedValue(outcome({ version: "4.4" }));
    await store.changeSfall("4.4", "Going back to sfall 4.4");
    expect(held).toHaveBeenCalledWith(expect.objectContaining({ path: PREVIEW_INSTALL }), "4.4");
    expect(store.notice?.text).toBe("sfall is now 4.4.");
  });

  test("installs by asking what the newest release is, and records it for the row that offers it", async () => {
    vi.spyOn(hostBackend, "latestSfall").mockResolvedValue({ version: "4.5", url: "https://example.invalid/4.5.7z" });
    const update = vi.spyOn(hostBackend, "updateSfall").mockResolvedValue(outcome());
    await store.installSfall();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ path: PREVIEW_INSTALL }), "4.5");
    expect(store.sfallLatest).toEqual({ version: "4.5", url: "https://example.invalid/4.5.7z" });
    expect(store.notice).toEqual({ kind: "done", text: "sfall 4.5 is installed." });
  });
});

describe("the list of sfall versions to change to", () => {
  afterEach(() => vi.restoreAllMocks());

  test("marks the list read even when the listing named none, so the dialog stops saying it is reading", async () => {
    vi.spyOn(hostBackend, "listSfallVersions").mockResolvedValue([]);
    await store.loadSfallVersions();
    expect(store.sfallVersionsRead, "answered with nothing is not the same as not answered").toBe(true);
    expect(store.notice).toEqual({
      kind: "problem",
      text: "The release listing named no versions. It may be worth trying again.",
    });
  });

  test("does not ask a second time once it holds a list", async () => {
    const asked = vi.spyOn(hostBackend, "listSfallVersions").mockResolvedValue(["4.5", "4.4"]);
    await store.loadSfallVersions();
    await store.loadSfallVersions();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(store.sfallVersions).toEqual(["4.5", "4.4"]);
  });
});

describe("the engine builds this machine holds", () => {
  afterEach(() => vi.restoreAllMocks());

  const RELEASE = { release: "continious", published: "2026-08-23T09:37:22Z", asset: null, commit: null };

  test("records what a check found, so the row can offer it without asking again", async () => {
    vi.spyOn(hostBackend, "engineReleases").mockResolvedValue([RELEASE]);
    await store.checkEngine("fallout2-ce");
    expect(store.engineLatest["fallout2-ce"]).toEqual(RELEASE);
  });

  // The feed answering with nothing is not a failure, and the row keeps whatever it already knew.
  test("leaves what it knew alone when the check found no release at all", async () => {
    vi.spyOn(hostBackend, "engineReleases").mockResolvedValue([RELEASE]);
    await store.checkEngine("fallout2-ce");
    vi.spyOn(hostBackend, "engineReleases").mockResolvedValue([]);
    await store.checkEngine("fallout2-ce");
    expect(store.engineLatest["fallout2-ce"]).toEqual(RELEASE);
  });

  test("rereads what the machine holds after dropping a build", async () => {
    const forget = vi.spyOn(hostBackend, "forgetEngine").mockResolvedValue();
    const machine = vi.spyOn(hostBackend, "machineEngines");
    await store.forgetEngine("fallout2-ce", "2026-08-23T09:37:22Z");
    expect(forget).toHaveBeenCalledWith("fallout2-ce", "2026-08-23T09:37:22Z");
    // Dropping a build without rereading leaves the row offering a copy that is no longer there.
    expect(machine).toHaveBeenCalled();
  });

  test("names an engine it does not know by its id, rather than by nothing", async () => {
    const asked = vi.spyOn(hostBackend, "engineReleases").mockResolvedValue([RELEASE]);
    await store.checkEngine("not-an-engine");
    expect(asked).toHaveBeenCalledWith("not-an-engine");
  });
});

describe("the buttons on the ZAX pane", () => {
  afterEach(() => vi.restoreAllMocks());

  test("says where the debug package went and how much went into it", async () => {
    vi.spyOn(hostBackend, "createDebugPackage").mockResolvedValue({
      path: "/home/t/.local/share/zax/debug/zax-debug.zip",
      contents: ["ddraw.ini", "f2_res.ini", "SLOT01"],
    });
    const opened = vi.spyOn(hostBackend, "open").mockResolvedValue();
    await store.createDebugPackage(["SLOT01"]);
    expect(opened).toHaveBeenCalledWith("debug");
    expect(store.notice).toEqual({
      kind: "done",
      text: "Wrote /home/t/.local/share/zax/debug/zax-debug.zip - 3 files.",
    });
  });

  // The archive is what was asked for, so a machine with no way to open a directory still reports success.
  test("still says where the package went when the directory could not be opened", async () => {
    vi.spyOn(hostBackend, "createDebugPackage").mockResolvedValue({ path: "/tmp/zax-debug.zip", contents: [] });
    vi.spyOn(hostBackend, "open").mockRejectedValue(new Error("no file manager here"));
    await store.createDebugPackage([]);
    expect(store.notice).toEqual({ kind: "done", text: "Wrote /tmp/zax-debug.zip - 0 files." });
  });

  test("opens a target and says nothing about it, there being nothing to report", async () => {
    const opened = vi.spyOn(hostBackend, "open").mockResolvedValue();
    await store.open("download");
    expect(opened).toHaveBeenCalledWith("download");
    expect(store.notice).toBeNull();
  });

  // The two wipes read differently because one empties a directory and the other truncates a file.
  test("reports clearing the log in its own words", async () => {
    vi.spyOn(hostBackend, "wipe").mockResolvedValue();
    await store.wipe("log");
    expect(store.notice).toEqual({ kind: "done", text: "Cleared the log." });
  });

  test("and names the directory it emptied for the others", async () => {
    vi.spyOn(hostBackend, "wipe").mockResolvedValue();
    await store.wipe("packages");
    expect(store.notice).toEqual({ kind: "done", text: "Emptied the packages directory." });
  });
});
