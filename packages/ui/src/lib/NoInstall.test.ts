// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import NoInstall from "./NoInstall.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  What a first run looks like. Its job is to say why the settings pane is empty and offer the two ways out, so
  the cases worth pinning are that both routes are reachable and that the scan reports itself while it runs -
  a button that did nothing visible for several seconds reads as broken.
*/

beforeEach(reseedPreview);
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

describe("the empty state", () => {
  test("says what ZAX needs rather than showing a blank pane", () => {
    const view = render(NoInstall as never, {} as never);
    expect(view.one("h2").textContent).toBe("No game to configure yet");
    expect(view.text()).toContain("needs to know where one is");
  });

  test("sends the user to the Games column, which is where a folder is added", () => {
    store.panel = "zax";
    const view = render(NoInstall as never, {} as never);
    view.control("Add one from the Games column").click();
    expect(store.panel).toBe("games");
  });

  test("offers the scan, and runs it through the store", () => {
    const scan = vi.spyOn(store, "scan").mockResolvedValue(undefined);
    render(NoInstall as never, {} as never)
      .control("Scan the usual places")
      .click();
    expect(scan).toHaveBeenCalledOnce();
  });

  test("reports the scan while it is running, and disables the button that started it", () => {
    store.busy = "Scanning";
    const view = render(NoInstall as never, {} as never);
    expect(view.text()).toContain("Looking...");
    expect(view.control("Scan the usual places").hasAttribute("disabled")).toBe(true);
    store.busy = null;
  });
});
