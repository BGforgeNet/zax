// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import InstallPanel from "./InstallPanel.svelte";
import { PREVIEW_INSTALL, render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The fields that belong to the install rather than to any config file. Each is written on commit rather than
  per keystroke, because each write is a rewrite of the state file on disk.
*/

beforeEach(reseedPreview);
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const panel = () => render(InstallPanel as never, {} as never);

const commit = (field: HTMLInputElement, value: string) => {
  field.value = value;
  field.dispatchEvent(new Event("change", { bubbles: true }));
};

describe("with an install selected", () => {
  test("shows the folder it edits", () => {
    expect(panel().text()).toContain(PREVIEW_INSTALL);
  });

  test("offers the alias, placeheld with what the game is rather than left blank", () => {
    const field = panel().one<HTMLInputElement>("input[aria-label=Alias]");
    expect(field.value).toBe("");
    expect(field.placeholder.length).toBeGreaterThan(0);
  });

  test("writes the alias on commit, not on every keystroke", () => {
    const setAlias = vi.spyOn(store, "setAlias").mockResolvedValue(undefined);
    const field = panel().one<HTMLInputElement>("input[aria-label=Alias]");

    field.value = "My Fallout";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(setAlias).not.toHaveBeenCalled();

    field.dispatchEvent(new Event("change", { bubbles: true }));
    expect(setAlias).toHaveBeenCalledWith(PREVIEW_INSTALL, "My Fallout");
  });
});

describe("the Wine fields", () => {
  /* Wine only exists off Windows, matching the previous interface, which hid its whole tab there. */
  test("are absent on a host that has no Wine", () => {
    const available = vi.spyOn(store, "wineAvailable", "get").mockReturnValue(false);
    expect(panel().all("input[aria-label=WINEPREFIX]")).toHaveLength(0);
    available.mockRestore();
  });

  test("are offered where Wine applies", () => {
    vi.spyOn(store, "wineAvailable", "get").mockReturnValue(true);
    const view = panel();
    expect(view.all("input[aria-label=WINEPREFIX]")).toHaveLength(1);
    expect(view.all("input[aria-label=WINEDEBUG]")).toHaveLength(1);
  });

  /*
    Each field writes the whole Wine record, so the one it is not editing has to be carried across - a write
    that sent only its own field would clear the other every time either was touched.
  */
  test("editing the prefix keeps the debug channels, and the other way round", () => {
    vi.spyOn(store, "wineAvailable", "get").mockReturnValue(true);
    const setWine = vi.spyOn(store, "setWine").mockResolvedValue(undefined);

    const view = panel();
    commit(view.one<HTMLInputElement>("input[aria-label=WINEPREFIX]"), "/home/u/.wine-f2");
    expect(setWine).toHaveBeenLastCalledWith(PREVIEW_INSTALL, { prefix: "/home/u/.wine-f2", debug: "" });

    commit(view.one<HTMLInputElement>("input[aria-label=WINEDEBUG]"), "-all");
    expect(setWine).toHaveBeenLastCalledWith(PREVIEW_INSTALL, { prefix: "", debug: "-all" });
  });
});

describe("with nothing selected", () => {
  test("says to pick an install rather than drawing empty fields", () => {
    store.installs = [];
    store.selectedInstall = "";
    const view = panel();
    expect(view.one("p.empty").textContent).toContain("Select an install");
    expect(view.all("input")).toHaveLength(0);
  });
});
