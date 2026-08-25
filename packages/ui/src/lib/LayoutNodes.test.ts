// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { LAYOUT, SETTINGS } from "@zax/fallout2";
import type { LayoutNode } from "@zax/fallout2";
import LayoutNodes from "./LayoutNodes.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The recursive walk that turns a tab's layout into rows. The previous layout nested frames - Resolution and
  Fullscreen both sit inside Graphics - so depth has to carry, and two entries are widgets rather than settings
  and stand in for whole blocks.
*/

const setting = SETTINGS.find((one) => one.targets.length === 1 && one.targets[0]!.file === "ddraw.ini");
if (!setting) throw new Error("the catalog no longer carries a plain ddraw.ini setting");

beforeEach(reseedPreview);
afterEach(unmountAll);

const draw = (items: readonly LayoutNode[], group?: string) =>
  render(LayoutNodes as never, (group === undefined ? { items } : { items, group }) as never);

describe("a frame", () => {
  test("draws its title and the rows inside it", () => {
    const view = draw([{ kind: "frame", title: "Graphics", items: [{ kind: "setting", id: setting.id }] }] as never);
    expect(view.one(".frame-title").textContent).toBe("Graphics");
    expect(view.text()).toContain(setting.label);
  });

  /* The depth is carried so a nested group ranks below its parent while still outranking its own rows. */
  test("nests, and each level records its depth", () => {
    const view = draw([
      {
        kind: "frame",
        title: "Graphics",
        items: [{ kind: "frame", title: "Resolution", items: [{ kind: "setting", id: setting.id }] }],
      },
    ] as never);
    const depths = view.all(".frame").map((frame) => frame.getAttribute("data-depth"));
    expect(depths).toEqual(["0", "1"]);
  });
});

describe("a hidden setting", () => {
  /*
    Controls the previous interface hid, plus any whose value the engine ignores. Kept hidden, except where ZAX
    pins the value: a pinned setting counts as a pending change, so hiding it would leave the user an unsaved
    count they can neither find nor revert.
  */
  test("is left out", () => {
    const view = draw([{ kind: "setting", id: setting.id, hidden: true }] as never);
    expect(view.text()).not.toContain(setting.label);
  });

  test("is drawn anyway where ZAX pins its value", () => {
    const pinned = SETTINGS.find((one) => one.managed);
    if (!pinned) return; // No setting is pinned in this catalog; nothing to assert.
    const view = draw([{ kind: "setting", id: pinned.id, hidden: true }] as never);
    expect(view.text()).toContain(pinned.label);
  });
});

describe("a setting the catalog does not describe", () => {
  test("is skipped rather than drawing an empty row", () => {
    const view = draw([{ kind: "setting", id: "no.such.setting" }] as never);
    expect(view.text()).toBe("");
  });
});

describe("the widgets", () => {
  test("the resolution widget draws the presets block", () => {
    const view = draw([{ kind: "widget", id: "f2_res.ini-resolution" }] as never);
    expect(view.text()).toContain("Select from common options");
  });

  test("the sfall widget draws the version block", () => {
    const view = draw([{ kind: "widget", id: "btn_sfall_check" }] as never);
    expect(view.text()).toContain("sfall version");
  });

  test("a widget nothing stands in for draws nothing, rather than failing", () => {
    expect(draw([{ kind: "widget", id: "btn_unknown_widget" }] as never).text()).toBe("");
  });
});

describe("driven from the real layout", () => {
  /*
    The generated layout is the input this component actually gets, and it is regenerated from upstream tables -
    so walking a real tab is what catches a node kind the walk has no arm for.
  */
  test("draws the first tab of the first group without dropping it to nothing", () => {
    const first = LAYOUT[0];
    const tab = first?.tabs[0];
    if (!first || !tab) throw new Error("the generated layout no longer carries a group with a tab");
    const view = draw(tab.items, first.id);
    expect(view.text().length).toBeGreaterThan(0);
    expect(store.defOf(setting.id)).toBeDefined();
  });
});
