// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import SettingsView from "./SettingsView.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The settings pane and its two strips of tabs. Almost everything here is a routing decision - which group is
  open, which of its tabs, whether the flat list or a layout is drawn - and each is reachable only by clicking,
  so none of it is observable from the store's own tests.
*/

beforeEach(async () => {
  await reseedPreview();
  await store.setQuery("");
});
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const view = () => render(SettingsView as never, {} as never);
const tabs = (v: ReturnType<typeof view>) =>
  v.all("[role=tab]").map((tab) => (tab.textContent ?? "").replace(/\s+/g, " ").trim());
const selected = (v: ReturnType<typeof view>) =>
  v
    .all("[role=tab]")
    .filter((tab) => tab.getAttribute("aria-selected") === "true")
    .map((tab) => (tab.textContent ?? "").trim());

describe("the group strip", () => {
  test("carries a tab per config group the install offers, plus the three fixed ones", () => {
    const drawn = tabs(view());
    for (const fixed of ["Install", "Troubleshooting", "All settings"]) expect(drawn).toContain(fixed);
    expect(drawn.length).toBeGreaterThan(3);
  });

  test("marks exactly one group tab and one sub-tab as selected", () => {
    expect(selected(view())).toHaveLength(2);
  });

  test("switching group moves the selection", () => {
    const v = view();
    v.control("Install").click();
    v.settle();
    expect(store.settingsTab).toBe("install");
    expect(v.control("Install").getAttribute("aria-selected")).toBe("true");
  });

  /*
    Always in the markup, shown or not: appearing on the first edit would widen the tab and shove every tab
    after it sideways while the pointer is still over one. Hidden from the accessible name, since the count
    belongs in the tooltip rather than in what a screen reader reads as the tab's label.
  */
  test("reserves the unsaved dot on every group tab, hidden from the accessible name", () => {
    const v = view();
    const dots = v.all(".dot");
    expect(dots.length).toBeGreaterThan(0);
    for (const dot of dots) expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  test("marks the dot and counts in its tooltip once a setting in that group is edited", async () => {
    const setting = "sfall.Misc.UseFileSystemOverride";
    store.set(setting, store.valueOf(setting) === "1" ? "0" : "1");
    await store.idle();
    const v = view();
    const marked = v.all(".dot.unsaved");
    expect(marked).toHaveLength(1);
    expect(marked[0]!.getAttribute("title")).toBe("1 unsaved");
  });
});

describe("the Install tab", () => {
  test("shows the install's own fields rather than a config file's", () => {
    store.settingsTab = "install";
    const v = view();
    expect(v.text()).toContain("Alias");
    expect(v.text()).toContain("Folder");
  });
});

describe("the Troubleshooting tab", () => {
  /* A fix is one click and a report is a sequence you work through, so the two stay apart. */
  test("offers the report and the fixes as separate sub-tabs", () => {
    store.settingsTab = "trouble";
    const v = view();
    expect(tabs(v)).toContain("Bug report");
    expect(tabs(v)).toContain("Fixes");
  });

  test("switching sub-tab swaps which panel is drawn", () => {
    store.settingsTab = "trouble";
    store.troubleTab = "report";
    const v = view();

    v.control("Fixes").click();
    v.settle();

    expect(store.troubleTab).toBe("fixes");
    expect(v.text()).toContain("One click each");
  });
});

describe("the All settings tab", () => {
  beforeEach(() => {
    store.settingsTab = "all";
  });

  /** The Install offer among the results, which shares its label with the group tab that is always drawn. */
  const offer = (v: ReturnType<typeof view>) =>
    v.all("button.found").find((button) => (button.textContent ?? "").trim() === "Install");

  test("offers a filter with an accessible name", () => {
    expect(view().one<HTMLInputElement>("input[type=search]").getAttribute("aria-label")).toBe("Filter settings");
  });

  /*
    Only while narrowing: with nothing typed, a count against the catalog total reads as a filter being applied
    when what is on screen is everything the layout places.
  */
  test("shows no result count until something is typed", () => {
    expect(view().all(".count")).toHaveLength(0);
  });

  test("counts matches against the catalog total once narrowed", async () => {
    await store.setQuery("damage");
    const v = view();
    expect(v.one(".count").textContent).toMatch(new RegExp(`^\\d+ of ${store.catalog?.settings.length}$`));
  });

  test("says what matched nothing rather than showing an empty list", async () => {
    await store.setQuery("zzzz-no-such-setting");
    const v = view();
    expect(v.text()).toContain('Nothing matches "zzzz-no-such-setting"');
  });

  /*
    Grouped under the address they came from, so a run of rows reads as the tab it belongs to rather than as one
    badge repeated down the column. The heading is also the way back to that tab.
  */
  test("heads each run of results with the tab they live on, and going there opens it", async () => {
    await store.setQuery("damage");
    const v = view();
    const heads = v.all("button.found");
    expect(heads.length).toBeGreaterThan(0);

    heads[0]!.click();
    v.settle();
    expect(store.settingsTab).not.toBe("all");
  });

  /*
    Install is the one settings tab holding nothing from the catalog, so search cannot reach it the way it
    reaches the rest: without this, "folder" reports nothing while the tab sits in plain view.
  */
  test("offers the Install tab as its own result, and going there clears the filter behind you", async () => {
    await store.setQuery("folder");
    const v = view();
    expect(store.installMatches, "the term the offer rests on").toBe(true);

    // Inside the results rather than by name: "Install" is also the group tab, which is always on screen.
    offer(v)!.click();
    v.settle();
    expect(store.settingsTab).toBe("install");
    // Cleared, or coming back to All settings would land on a filter the user has already moved past.
    expect(store.query).toBe("");
  });

  test("draws no Install offer for a term the tab has nothing to do with", async () => {
    await store.setQuery("damage");
    expect(store.installMatches).toBe(false);
    expect(offer(view())).toBeUndefined();
  });

  // Ctrl-F from the window: the tab is opened by the store, and the pane is what puts the caret in the box.
  test("focuses and selects the filter when the window asks for search", async () => {
    await store.setQuery("damage");
    const v = view();
    const box = v.one<HTMLInputElement>("input[type=search]");
    expect(document.activeElement).not.toBe(box);

    store.searchSettings();
    v.settle();
    expect(document.activeElement, "so the next keystroke replaces what is there").toBe(box);
  });
});

describe("moving between tabs by clicking", () => {
  test("a group tab, a sub-tab, Troubleshooting and All settings each open what they name", () => {
    const v = view();
    const group = store.settingsGroups.find((one) => one.group.tabs.length > 1)!.group;
    v.control(group.label).click();
    v.settle();
    expect(store.settingsTab).toBe(group.id);

    const second = group.tabs[1]!.title;
    v.control(second).click();
    v.settle();
    expect(store.fileTab[group.id]).toBe(second);
    expect(v.control(second).getAttribute("aria-selected")).toBe("true");

    v.control("Troubleshooting").click();
    v.settle();
    expect(store.settingsTab).toBe("trouble");
    v.control("All settings").click();
    v.settle();
    expect(store.settingsTab).toBe("all");
  });

  test("typing in the filter narrows through the store", async () => {
    store.settingsTab = "all";
    const v = view();
    const box = v.one<HTMLInputElement>("input[type=search]");
    box.value = "damage";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await expect.poll(() => store.query).toBe("damage");
  });
});

describe("an engine's group tab", () => {
  test("is titled with the engine's full name rather than its id, and with the id for an engine not listed", () => {
    // The preview's install runs no engine's settings, so the group is offered here from the catalog's own layout.
    const group = store.catalog!.layout.find((one) => one.engine === "fission");
    if (!group) throw new Error("the catalog's layout no longer carries Fission's group");
    const spy = vi.spyOn(store, "settingsGroups", "get").mockReturnValue([{ group, refusal: null }]);
    const engine = store.engines.find((one) => one.id === "fission")!;
    expect(view().control(group.label).getAttribute("title")).toBe(engine.name);
    unmountAll();

    vi.spyOn(store, "engines", "get").mockReturnValue([]);
    expect(view().control(group.label).getAttribute("title")).toBe("fission");
    spy.mockRestore();
    vi.restoreAllMocks();
  });
});

describe("a group whose rows refuse input", () => {
  test("says why above the rows when the group gives a reason", () => {
    const group = store.settingsGroups[0]!.group;
    const offered = store.settingsGroups.map((one) =>
      one.group.id === group.id ? { ...one, refusal: "Run the engine once first." } : one,
    );
    const spy = vi.spyOn(store, "settingsGroups", "get").mockReturnValue(offered);
    store.settingsTab = group.id;
    const v = view();
    expect(v.text()).toContain("Run the engine once first.");
    expect(v.control(group.label).getAttribute("title")).toBe("Run the engine once first.");
    spy.mockRestore();
  });

  test("says what is missing when the install does not have the group's file", () => {
    store.settingsTab = "fallout2.cfg";
    const spy = vi.spyOn(store, "hasFile").mockReturnValue(false);
    expect(view().text()).toContain("The game has not written its configuration file yet.");
    spy.mockRestore();
  });
});

describe("the hi-res patch's version", () => {
  test("heads the first tab of f2_res.ini, and no other", () => {
    store.settingsTab = "f2_res.ini";
    expect(
      view()
        .all(".frame-title")
        .map((title) => title.textContent),
    ).toContain("Patch");
    unmountAll();

    const group = store.settingsGroups.find((one) => one.group.id === "f2_res.ini")!.group;
    store.fileTab = { ...store.fileTab, "f2_res.ini": group.tabs[1]!.title };
    expect(
      view()
        .all(".frame-title")
        .map((title) => title.textContent),
    ).not.toContain("Patch");
  });
});
