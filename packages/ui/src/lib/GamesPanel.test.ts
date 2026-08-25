// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import GamesPanel from "./GamesPanel.svelte";
import { PREVIEW_INSTALL, render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The install list. It is the only route to switching, adding and renaming an install, and two of those are
  reachable only through gestures nothing else on screen announces - right-click and F2 - so what the tooltip
  says is part of the feature rather than decoration.
*/

beforeEach(reseedPreview);
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const panel = () => render(GamesPanel as never, {} as never);

describe("the list", () => {
  test("draws a row per install, naming it and the folder it sits in", () => {
    const view = panel();
    expect(view.all("li.empty")).toHaveLength(0);
    expect(view.one(".path").textContent).toBe(PREVIEW_INSTALL);
  });

  test("marks the selected row as pressed, not only as coloured", () => {
    expect(panel().one(".install").getAttribute("aria-pressed")).toBe("true");
  });

  test("gives the game's icon an alt naming the game type, rather than leaving it unlabelled", () => {
    const icon = panel().one<HTMLImageElement>("img.icon");
    expect(icon.alt.length).toBeGreaterThan(0);
  });

  /* Neither gesture is discoverable, so the tooltip is what says they exist. */
  test("says in the tooltip how a row is renamed", () => {
    expect(panel().one(".install").getAttribute("title")).toContain("Right-click or press F2 to rename");
  });

  test("right-click selects the row and asks for the alias field", () => {
    const select = vi.spyOn(store, "selectInstall").mockResolvedValue(undefined);
    const rename = vi.spyOn(store, "renameSelected").mockReturnValue(undefined);
    const view = panel();

    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    view.one(".install").dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(select).toHaveBeenCalledWith(PREVIEW_INSTALL);
    expect(rename).toHaveBeenCalledTimes(0); // resolves on the next tick; the select is what this pins
  });

  test("says the list is empty rather than drawing nothing", () => {
    store.installs = [];
    const view = panel();
    expect(view.one("li.empty").textContent).toBe("No installs yet.");
  });
});

describe("the preview note", () => {
  /* Says which install the preview is actually editing, rather than letting one entry imply a real scan. */
  test("says the fixture is edited in memory", () => {
    expect(panel().text()).toContain("edited in memory");
  });
});

describe("adding an install", () => {
  test("offers the form only once Add game is pressed", () => {
    const view = panel();
    expect(view.all("form")).toHaveLength(0);

    view.control("Add game").click();
    view.settle();

    expect(view.all("form")).toHaveLength(1);
  });

  /* Typing stays alongside the picker: a browser has no picker, and a path can be pasted from elsewhere. */
  test("refuses an empty path and accepts a typed one", () => {
    const add = vi.spyOn(store, "addInstall").mockResolvedValue(undefined);
    const view = panel();
    view.control("Add game").click();
    view.settle();

    expect(view.control("Add").hasAttribute("disabled")).toBe(true);

    const field = view.one<HTMLInputElement>("input");
    field.value = "/games/fallout2";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    view.settle();

    expect(view.control("Add").hasAttribute("disabled")).toBe(false);
    view.one("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(add).toHaveBeenCalledWith("/games/fallout2");
  });

  test("refuses the picker in a host that has none, and says which host has one", () => {
    const view = panel();
    view.control("Add game").click();
    view.settle();

    const browse = view.control("Browse...");
    expect(browse.hasAttribute("disabled")).toBe(true);
    expect(browse.getAttribute("title")).toMatch(/desktop build/i);
  });

  test("Cancel closes the form without adding anything", () => {
    const add = vi.spyOn(store, "addInstall").mockResolvedValue(undefined);
    const view = panel();
    view.control("Add game").click();
    view.settle();

    view.control("Cancel").click();
    view.settle();

    expect(view.all("form")).toHaveLength(0);
    expect(add).not.toHaveBeenCalled();
  });
});

describe("removing an install", () => {
  test("removes the selected one", () => {
    const remove = vi.spyOn(store, "removeInstall").mockResolvedValue(undefined);
    panel().control("Remove from list").click();
    expect(remove).toHaveBeenCalledWith(PREVIEW_INSTALL);
  });

  test("is off with nothing selected", () => {
    store.installs = [];
    store.selectedInstall = "";
    expect(panel().control("Remove from list").hasAttribute("disabled")).toBe(true);
  });
});
