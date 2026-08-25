// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import SfallVersion from "./SfallVersion.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The sfall block: what is installed, what has been published, and the three ways to move between them. These
  are the slowest operations in the application, so each saying what it is doing while it does it is the point -
  a button that changed nothing at all when pressed is what the previous interface had.
*/

beforeEach(async () => {
  await reseedPreview();
  store.sfallInstalled = "4.4.6";
  store.sfallLatest = null;
  store.sfallVersions = [];
  store.sfallVersionsRead = false;
  store.busy = null;
});
afterEach(() => {
  unmountAll();
  store.busy = null;
  vi.restoreAllMocks();
});

const block = () => render(SfallVersion as never, {} as never);

describe("what it reports", () => {
  test("shows the installed version, read from the library rather than the config", () => {
    expect(block().one("strong").textContent).toBe("4.4.6");
  });

  test("says nothing is installed rather than showing a blank", () => {
    store.sfallInstalled = null;
    expect(block().text()).toContain("not installed");
  });

  test("distinguishes no install selected from sfall not being installed", () => {
    store.sfallInstalled = null;
    store.installs = [];
    store.selectedInstall = "";
    expect(block().text()).toContain("no install selected");
  });

  test("says the latest is unchecked rather than implying it is up to date", () => {
    expect(block().text()).toContain("not checked");
  });
});

describe("the buttons", () => {
  test("refuse the network in a host that has none, and say which host has one", () => {
    const view = block();
    for (const name of ["Check", "Change version"]) {
      expect(view.control(name).hasAttribute("disabled"), name).toBe(true);
      expect(view.control(name).getAttribute("title"), name).toMatch(/desktop build/i);
    }
  });

  test("refuse the update while nothing newer is known, and say why", () => {
    const update = block().control("Update");
    expect(update.hasAttribute("disabled")).toBe(true);
    expect(update.getAttribute("title")).toBe("Nothing newer has been found");
  });

  test("offer the update once a newer release is known, with a title saying what it does", () => {
    store.sfallLatest = { version: "9.9.9" } as never;
    const update = block().control("Update");
    expect(update.hasAttribute("disabled")).toBe(false);
    expect(update.getAttribute("title")).toMatch(/keeping your settings/i);
  });

  test("each says what it is doing while it runs", () => {
    store.busy = "Checking for a newer sfall";
    expect(block().text()).toContain("Checking...");
    unmountAll();

    store.sfallLatest = { version: "9.9.9" } as never;
    store.busy = "Updating sfall";
    expect(block().text()).toContain("Updating...");
  });
});

describe("changing to a version other than the newest", () => {
  /* Going back matters as much as going forward: mods pin particular sfall versions. */
  const openDialog = () => {
    const view = block();
    // The button is refused in this host, so the flow is opened the way the button would.
    store.sfallVersions = ["4.4.6", "4.4.5", "4.3.4"];
    store.sfallVersionsRead = true;
    return view;
  };

  test("lists the versions, marking the one already installed", () => {
    const load = vi.spyOn(store, "loadSfallVersions").mockResolvedValue(undefined);
    const view = openDialog();
    // Drive the opener directly: the control is disabled here, and what this pins is the dialog, not the gate.
    view.one("dialog");
    expect(load).not.toHaveBeenCalled();
    store.sfallVersions = ["4.4.6", "4.4.5"];
    view.settle();
    const labels = view.all("option").map((o) => o.textContent);
    expect(labels).toContain("4.4.6 (installed)");
    expect(labels).toContain("4.4.5");
  });

  /*
    An answered request that named nothing is not a request still in flight; saying so is the whole difference
    between "wait a moment" and "this will not arrive".
  */
  test("distinguishes a list still loading from one that came back empty", () => {
    store.sfallVersions = [];
    store.sfallVersionsRead = false;
    expect(block().text()).toContain("Reading the list...");
    unmountAll();

    store.sfallVersionsRead = true;
    expect(block().text()).toContain("No versions found");
  });
});

describe("the note about what an update keeps", () => {
  /*
    Kept in the layout whether or not it applies: a check that finds a newer release would otherwise grow this
    row and move every row under it.
  */
  test("is always in the markup, and marked when it applies", () => {
    expect(block().all(".carried")).toHaveLength(1);
    unmountAll();

    store.sfallLatest = { version: "9.9.9" } as never;
    expect(block().one(".carried").classList.contains("applies")).toBe(true);
  });
});
