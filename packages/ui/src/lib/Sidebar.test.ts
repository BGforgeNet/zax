// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import Sidebar from "./Sidebar.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  A permanent column rather than a destination you navigate to: which install you are editing is context for
  every other screen, and picking one should not cost you your place in the settings. Its only decision is
  which of the two panels is below the strip.
*/

beforeEach(async () => {
  await reseedPreview();
  store.panel = "games";
});
afterEach(unmountAll);

const sidebar = () => render(Sidebar as never, {} as never);

describe("the strip", () => {
  test("offers the two panels as tabs, with the install count on the Games one", () => {
    const view = sidebar();
    const tabs = view.all("[role=tab]");
    expect(tabs).toHaveLength(2);
    expect(view.one(".count").textContent).toBe(String(store.installs.length));
  });

  test("marks exactly one tab as selected", () => {
    const selected = sidebar()
      .all("[role=tab]")
      .filter((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
  });
});

describe("switching panel", () => {
  test("swaps which panel is drawn below the strip", () => {
    const view = sidebar();
    expect(view.text()).toContain("Add game");

    view.all("[role=tab]")[1]!.click();
    view.settle();

    expect(store.panel).toBe("zax");
    expect(view.text()).toContain("Auto scan for games");
    expect(view.text()).not.toContain("Add game");
  });
});
