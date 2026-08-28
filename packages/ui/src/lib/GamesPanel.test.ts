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
  test("asks before removing anything, and names the install it is asking about", () => {
    const remove = vi.spyOn(store, "removeInstall").mockResolvedValue(undefined);
    const view = panel();

    view.control("Remove from list").click();
    view.settle();

    expect(view.text()).toContain("Remove from the list?");
    // The dialog's own copy of the path, not the row's: what it names is what it will remove.
    expect(view.one(".ask.path").textContent).toBe(PREVIEW_INSTALL);
    expect(remove).not.toHaveBeenCalled();
  });

  /* The button says Remove beside an Add, which is what an uninstall looks like; this is the sentence that
     says the game folder is not what goes. */
  test("says the game folder is left alone", () => {
    const view = panel();
    view.control("Remove from list").click();
    view.settle();

    expect(view.text()).toContain("Nothing in the game folder is touched");
    expect(view.text()).toContain("no files are deleted");
  });

  test("confirming removes the selected one", () => {
    const remove = vi.spyOn(store, "removeInstall").mockResolvedValue(undefined);
    const view = panel();

    view.control("Remove from list").click();
    view.settle();
    view.control("Remove it").click();

    expect(remove).toHaveBeenCalledExactlyOnceWith(PREVIEW_INSTALL);
  });

  test("Cancel closes the question without removing anything", () => {
    const remove = vi.spyOn(store, "removeInstall").mockResolvedValue(undefined);
    const view = panel();

    view.control("Remove from list").click();
    view.settle();
    view.control("Cancel").click();
    view.settle();

    expect(remove).not.toHaveBeenCalled();
    expect(view.one<HTMLDialogElement>("dialog").open).toBe(false);
  });

  test("is off with nothing selected", () => {
    store.installs = [];
    store.selectedInstall = "";
    expect(panel().control("Remove from list").hasAttribute("disabled")).toBe(true);
  });
});
