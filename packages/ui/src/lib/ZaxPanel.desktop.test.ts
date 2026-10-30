// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ZaxPanel from "./ZaxPanel.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The same column as the desktop draws it. The buttons the preview refuses - opening a directory, checking for a
  release - are live there, and what is under test is that each reaches the store with the place it names. The
  commands still land on the preview, which is fine: every store call here is spied on.
*/
vi.mock("./invoke.js", async (importOriginal) => ({ ...(await importOriginal<object>()), isPreview: false }));

beforeEach(reseedPreview);
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const panel = () => render(ZaxPanel as never, {} as never);

describe("on the desktop", () => {
  test("opens each directory and the log in the file manager, by the place its row names", () => {
    const open = vi.spyOn(store, "open").mockResolvedValue(undefined);
    const view = panel();
    const opens = view.all("button").filter((button) => ["Open", "View"].includes(button.textContent?.trim() ?? ""));
    expect(opens).toHaveLength(4);
    for (const button of opens) {
      expect(button.hasAttribute("disabled")).toBe(false);
      button.click();
    }
    expect(open.mock.calls.map(([place]) => place)).toEqual(["backup", "packages", "debug", "log"]);
  });

  test("checks for a release through the store", () => {
    const check = vi.spyOn(store, "checkZaxVersion").mockResolvedValue(undefined);
    panel().control("Check").click();
    expect(check).toHaveBeenCalledOnce();
  });

  test("opens the download once a newer release is known, and not before", () => {
    const open = vi.spyOn(store, "open").mockResolvedValue(undefined);
    expect(panel().control("Download latest").hasAttribute("disabled")).toBe(true);
    unmountAll();

    vi.spyOn(store, "zaxOutdated", "get").mockReturnValue(true);
    const view = panel();
    view.control("Download latest").click();
    expect(open).toHaveBeenCalledExactlyOnceWith("download");
  });

  test("says what is running on a button an operation holds, rather than the preview's reason", () => {
    vi.spyOn(store, "busy", "get").mockReturnValue("Saving");
    const check = panel().control("Check");
    expect(check.hasAttribute("disabled")).toBe(true);
    expect(check.getAttribute("title")).toBe(store.busyReason);
    expect(check.getAttribute("title")).not.toMatch(/desktop build/i);
  });
});
