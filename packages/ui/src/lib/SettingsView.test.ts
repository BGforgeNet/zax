// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SETTINGS } from "@zax/fallout2";
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
  store.query = "";
});
afterEach(unmountAll);

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

  test("marks the dot and counts in its tooltip once a setting in that group is edited", () => {
    const setting = "sfall.Misc.UseFileSystemOverride";
    store.set(setting, store.valueOf(setting) === "1" ? "0" : "1");
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

  test("counts matches against the catalog total once narrowed", () => {
    store.query = "damage";
    const v = view();
    expect(v.one(".count").textContent).toMatch(new RegExp(`^\\d+ of ${SETTINGS.length}$`));
  });

  test("says what matched nothing rather than showing an empty list", () => {
    store.query = "zzzz-no-such-setting";
    const v = view();
    expect(v.text()).toContain('Nothing matches "zzzz-no-such-setting"');
  });

  /*
    Grouped under the address they came from, so a run of rows reads as the tab it belongs to rather than as one
    badge repeated down the column. The heading is also the way back to that tab.
  */
  test("heads each run of results with the tab they live on, and going there opens it", () => {
    store.query = "damage";
    const v = view();
    const heads = v.all("button.found");
    expect(heads.length).toBeGreaterThan(0);

    heads[0]!.click();
    v.settle();
    expect(store.settingsTab).not.toBe("all");
  });
});
