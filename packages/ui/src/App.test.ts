// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import App from "./App.svelte";
import { render, reseedPreview, unmountAll } from "./lib/preview-fixture.js";
import { store } from "./lib/store.svelte.js";

/*
  The shell: the three views, the notice band, the busy indicator and the two window keys. Everything here is a
  routing or chrome decision that no other component can be asked about, and two of them - the theme attribute
  and the keyboard shortcuts - reach outside the component tree entirely.
*/

beforeEach(async () => {
  await reseedPreview();
  store.view = "settings";
  store.notice = null;
  store.busy = null;
});
afterEach(() => {
  unmountAll();
  store.busy = null;
  store.notice = null;
  document.documentElement.removeAttribute("data-theme");
  vi.restoreAllMocks();
});

const app = () => render(App as never, {} as never);
const topTabs = (view: ReturnType<typeof app>) =>
  view.all(".topbar [role=tab]").map((tab) => (tab.textContent ?? "").trim());

describe("the view strip", () => {
  /*
    Settings are keys in config files, mods are what the engine loads and an engine is what runs them: a change
    of subject rather than another tab of one. All three are always offered - an install with no mods folder yet
    is exactly the one whose owner is about to add one.
  */
  test("always offers all three, whatever the install has", () => {
    expect(topTabs(app())).toEqual(["Settings", "Mods", "Engines"]);
  });

  test("switching moves both the selection and the pane below it", () => {
    const view = app();
    view.all(".topbar [role=tab]")[2]!.click();
    view.settle();

    expect(store.view).toBe("engines");
    expect(view.all(".topbar [role=tab]")[2]!.getAttribute("aria-selected")).toBe("true");
  });

  /* Held in the markup shown or not: selection must not resize a tab and shift the ones after it. */
  test("reserves the unsaved dot on both tabs that can have one, hidden from the accessible name", () => {
    const dots = app().all(".topbar .dot");
    expect(dots).toHaveLength(2);
    for (const dot of dots) expect(dot.getAttribute("aria-hidden")).toBe("true");
  });

  test("marks the settings dot once a setting is edited, and says so in its tooltip", () => {
    const setting = "sfall.Misc.UseFileSystemOverride";
    store.set(setting, store.valueOf(setting) === "1" ? "0" : "1");
    const view = app();
    const dot = view.all(".topbar .dot")[0]!;
    expect(dot.classList.contains("unsaved")).toBe(true);
    expect(dot.getAttribute("title")).toBe("Settings have unsaved changes");
  });
});

describe("the notice band", () => {
  /*
    Above both columns rather than beside the button that started the operation: several of those buttons live
    in the sidebar, and a message that scrolls away with its panel is one the user never reads.
  */
  test("is absent with nothing to say", () => {
    expect(app().all(".notice")).toHaveLength(0);
  });

  test("announces an outcome as a status, and can be dismissed", () => {
    store.notice = { kind: "done", text: "Saved 3 settings." };
    const view = app();

    const band = view.one(".notice");
    expect(band.getAttribute("role")).toBe("status");
    expect(band.textContent).toContain("Saved 3 settings.");

    view.control("Dismiss").click();
    view.settle();
    expect(store.notice).toBeNull();
    expect(view.all(".notice")).toHaveLength(0);
  });

  test("distinguishes a problem and a note from an ordinary outcome", () => {
    store.notice = { kind: "problem", text: "The feed could not be reached." };
    expect(app().one(".notice").classList.contains("problem")).toBe(true);
    unmountAll();

    store.notice = { kind: "note", text: "Wine logging was turned back on." };
    expect(app().one(".notice").classList.contains("note")).toBe(true);
  });
});

describe("the busy indicator", () => {
  /*
    For every operation rather than only the ones whose own button changes label: an sfall update is minutes of
    work, and the button that starts it may be in a panel the user has scrolled away from.
  */
  test("is absent while nothing is running", () => {
    expect(app().all(".working")).toHaveLength(0);
  });

  test("names what is running, announced as a status", () => {
    store.busy = "Updating sfall";
    const working = app().one(".working");
    expect(working.getAttribute("role")).toBe("status");
    expect(working.textContent).toContain("Updating sfall");
  });

  test("prefers the progress text over the bare operation name once there is one", () => {
    store.busy = "Updating sfall";
    store.progress = { label: "Downloading sfall", received: 5, total: 10 } as never;
    expect(app().one(".working").textContent).toContain(store.progressText ?? "");
    store.progress = null;
  });
});

describe("the theme", () => {
  /*
    The palette reads the used color-scheme, so applying a theme is one attribute on the root element. "system"
    removes it rather than pinning a value, or the choice would stop following the OS.
  */
  test("stamps the chosen theme on the root element", () => {
    store.theme = "dark";
    app();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  test("removes the attribute for system rather than writing a value", () => {
    store.theme = "dark";
    const view = app();
    store.theme = "system";
    view.settle();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  });
});

describe("the window keys", () => {
  /*
    At the window rather than on a row: the browser's own find would search only the tab that happens to be
    rendered, and F2 has to work without the install row holding focus.
  */
  test("Ctrl-F opens the all-settings filter instead of the browser's own find", () => {
    const search = vi.spyOn(store, "searchSettings").mockReturnValue(undefined);
    app();
    const event = new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(search).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  test("Cmd-F does the same, for the platform that uses it", () => {
    const search = vi.spyOn(store, "searchSettings").mockReturnValue(undefined);
    app();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true, bubbles: true, cancelable: true }));
    expect(search).toHaveBeenCalledOnce();
  });

  test("F2 renames the selected install", () => {
    const rename = vi.spyOn(store, "renameSelected").mockReturnValue(undefined);
    app();
    const event = new KeyboardEvent("keydown", { key: "F2", bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(rename).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  test("an ordinary key is left to the page", () => {
    const search = vi.spyOn(store, "searchSettings").mockReturnValue(undefined);
    app();
    const event = new KeyboardEvent("keydown", { key: "f", bubbles: true, cancelable: true });
    window.dispatchEvent(event);

    expect(search).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("with no install", () => {
  test("shows the first-run screen and no save bar for it to act on", () => {
    store.installs = [];
    store.selectedInstall = "";
    store.loaded = true;
    const view = app();

    expect(view.text()).toContain("No game to configure yet");
    expect(view.all(".footer")).toHaveLength(0);
  });

  /*
    While the state file is still being read the views draw their empty shape, so the bar draws with them rather
    than appearing under the pointer a moment later.
  */
  test("keeps the save bar while the state file is still being read", () => {
    store.installs = [];
    store.selectedInstall = "";
    store.loaded = false;
    const view = app();

    expect(view.text()).not.toContain("No game to configure yet");
    expect(view.all(".footer")).toHaveLength(1);
  });
});

describe("where to report a problem", () => {
  test("carries the source and the forum, and names the bare mark for a screen reader", () => {
    const view = app();
    const links = view.all<HTMLAnchorElement>(".powered a").map((a) => a.getAttribute("href"));
    expect(links).toContain("https://github.com/BGforgeNet/zax");
    expect(links).toContain("https://forums.bgforge.net/viewtopic.php?t=365");
    expect(view.one("a.mark").getAttribute("aria-label")).toBe("Source on GitHub");
  });

  /* Every outbound link leaves the page, so none of them may hand the opener to what it opens. */
  test("opens every outbound link without handing over the opener", () => {
    for (const link of app().all<HTMLAnchorElement>("a[target=_blank]")) {
      expect(link.getAttribute("rel"), link.getAttribute("href") ?? "").toBe("noreferrer");
    }
  });
});
