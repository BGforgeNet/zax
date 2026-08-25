// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import ZaxPanel from "./ZaxPanel.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";
import { VERSION } from "./version.js";

/*
  The application's own column. Three of its buttons delete files the user cannot get back from here, and they
  sit beside an Open button they otherwise look like - so the confirmation, and the fact that it names which
  directory is about to go, is the feature rather than a nicety.
*/

beforeEach(async () => {
  await reseedPreview();
  store.zaxLatest = null;
});
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const panel = () => render(ZaxPanel as never, {} as never);

describe("the version block", () => {
  test("shows the running build, and says the latest is unchecked rather than showing nothing", () => {
    const view = panel();
    expect(view.text()).toContain(VERSION);
    expect(view.text()).toContain("not checked");
  });

  /* ZAX does not replace its own running binary, so the download is only offered once there is a newer one. */
  test("offers no download while nothing newer has been found, and says why", () => {
    const button = panel().control("Download latest");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("Nothing newer has been found");
  });

  test("offers the download once a newer release is known", () => {
    store.zaxLatest = "999.0.0";
    const view = panel();
    expect(view.text()).toContain("999.0.0");
    // Still refused in a host that cannot leave the page, but the reason changes to the one that matters.
    expect(view.control("Download latest").getAttribute("title")).toBe("Open the download for this machine");
  });

  test("refuses the check in a host with no machine to reach, and says so", () => {
    expect(panel().control("Check").getAttribute("title")).toMatch(/desktop build/i);
  });
});

describe("the directories", () => {
  test("names the path of each one it offers to open or empty", () => {
    const view = panel();
    for (const path of [store.paths.backup, store.paths.packages, store.paths.debug, store.paths.log]) {
      expect(view.text()).toContain(path);
    }
  });

  test("offers a Wipe for the three that hold files, and Clear for the log", () => {
    // The log is a file rather than a directory, so it is cleared rather than emptied, and it is read from
    // here as well - hence the View beside it.
    const labels = panel()
      .all("button")
      .map((b) => b.textContent?.trim());
    expect(labels.filter((label) => label === "Wipe")).toHaveLength(3);
    expect(labels.filter((label) => label === "View")).toHaveLength(1);
    expect(labels.filter((label) => label === "Clear")).toHaveLength(1);
  });

  test("says the log is trimmed, so a missing older line is not read as a lost one", () => {
    expect(panel().text()).toContain("Trimmed to its most recent half when it passes a megabyte.");
  });
});

describe("emptying a directory", () => {
  const wipeButtons = (view: ReturnType<typeof panel>) =>
    view.all("button").filter((b) => b.textContent?.trim() === "Wipe");

  test("asks first, naming the directory and what is in it", () => {
    const wipe = vi.spyOn(store, "wipe").mockResolvedValue(undefined);
    const view = panel();

    wipeButtons(view)[0]!.click();
    view.settle();

    expect(view.text()).toContain("Backup directory");
    expect(view.text()).toContain("ZAX cannot put them back");
    expect(wipe).not.toHaveBeenCalled();
  });

  test("Cancel closes the question and deletes nothing", () => {
    const wipe = vi.spyOn(store, "wipe").mockResolvedValue(undefined);
    const view = panel();

    wipeButtons(view)[0]!.click();
    view.settle();
    view.control("Cancel").click();
    view.settle();

    expect(wipe).not.toHaveBeenCalled();
  });

  test("confirming empties the directory that was asked about, not another", () => {
    const wipe = vi.spyOn(store, "wipe").mockResolvedValue(undefined);
    const view = panel();

    // The second Wipe is the downloaded-packages one; picking a non-first entry is what catches a hard-coded arg.
    wipeButtons(view)[1]!.click();
    view.settle();
    expect(view.text()).toContain("Downloaded packages");
    expect(view.text()).toContain("Empty this directory?");

    view.control("Empty it").click();
    expect(wipe).toHaveBeenCalledExactlyOnceWith("packages");
  });

  test("asks before clearing the log, and says what clearing it costs", () => {
    const wipe = vi.spyOn(store, "wipe").mockResolvedValue(undefined);
    const view = panel();

    view.control("Clear").click();
    view.settle();
    // The log is one file, so every word of the confirmation says so - a directory's wording here would tell
    // the user their backups were about to go.
    expect(view.text()).toContain("Clear the log?");
    expect(view.text()).toContain("Log file");
    expect(view.text()).toContain("A bug report made after this carries none of it.");
    expect(view.text()).toContain("This deletes the file. ZAX cannot put it back.");
    expect(view.text()).not.toContain("Empty this directory?");
    expect(wipe).not.toHaveBeenCalled();

    view.control("Clear it").click();
    expect(wipe).toHaveBeenCalledExactlyOnceWith("log");
  });
});

describe("the theme", () => {
  /* The only control here that needs nothing outside the page, so the only one that works in every host. */
  test("offers the three themes and writes the chosen one", () => {
    const setTheme = vi.spyOn(store, "setTheme").mockResolvedValue(undefined);
    const view = panel();
    const select = view.one<HTMLSelectElement>("select");

    expect(view.all("option").map((o) => o.getAttribute("value"))).toEqual(["system", "light", "dark"]);

    select.value = "dark";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(setTheme).toHaveBeenCalledWith("dark");
  });
});

describe("autosave", () => {
  test("reflects the stored setting and writes a change through the store", () => {
    const setAutosave = vi.spyOn(store, "setAutosave").mockResolvedValue(undefined);
    const view = panel();
    const box = view.one<HTMLInputElement>("input[type=checkbox]");

    expect(box.checked).toBe(store.autosave);
    box.checked = !box.checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(setAutosave).toHaveBeenCalledWith(box.checked);
  });
});
