import { describe, expect, test } from "vitest";
import { SETTINGS } from "@zax/fallout2";
import { store } from "./store.svelte.js";

describe("installs", () => {
  const seed = () => {
    store.installs = [
      { path: "/games/a", type: "fallout2" },
      { path: "/games/b", type: "fallout2rpu" },
    ];
    store.selectInstall("/games/a");
  };

  test("removing the selected install moves the selection rather than stranding it", () => {
    seed();
    store.removeInstall("/games/a");
    // Every settings view reads the selected install, so leaving it pointing at a removed one would leave
    // them all bound to something no longer in the list.
    expect(store.selectedInstall).toBe("/games/b");
    expect(store.install?.path).toBe("/games/b");
  });

  test("removing an install that is not selected leaves the selection alone", () => {
    seed();
    store.removeInstall("/games/b");
    expect(store.selectedInstall).toBe("/games/a");
  });

  test("removing the last install leaves nothing selected rather than a stale path", () => {
    seed();
    store.removeInstall("/games/a");
    store.removeInstall("/games/b");
    expect(store.selectedInstall).toBe("");
    expect(store.install).toBeUndefined();
  });

  test("wine settings attach to one install and survive a change to the other", () => {
    seed();
    store.setWine("/games/a", { prefix: "/home/u/.wine-a" });
    store.setWine("/games/b", { debug: "-all" });
    expect(store.installs.find((g) => g.path === "/games/a")?.wine).toEqual({ prefix: "/home/u/.wine-a" });
    expect(store.installs.find((g) => g.path === "/games/b")?.wine).toEqual({ debug: "-all" });
  });
});

describe("search", () => {
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
    // Wine's two fields belong to the install, not to a config file, so they are not in SETTINGS at all - and
    // a search that silently omits a whole tab reads as a search that does not work.
    store.query = "wine";
    expect(store.results, "wine holds no catalog settings").toEqual([]);
    expect(store.wineMatches).toBe(true);

    store.query = "wineprefix";
    expect(store.wineMatches).toBe(true);

    store.query = "worldmap";
    expect(store.wineMatches, "an unrelated query must not offer it").toBe(false);
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
