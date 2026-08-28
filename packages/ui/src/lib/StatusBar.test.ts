// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import StatusBar from "./StatusBar.svelte";
import { backend as hostBackend } from "./host.js";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The window's floor: what is running, and the one control that stops it. It used to sit in the tab strip, where
  a step naming a mod shared a row with three fixed labels and the credit - the tabs were the only thing there
  that could give way, so a long download turned them into a strip the user had to scroll.
*/

beforeEach(async () => {
  await reseedPreview();
  store.busy = null;
  store.progress = null;
  store.cancelling = false;
});
afterEach(() => {
  unmountAll();
  store.busy = null;
  store.progress = null;
  store.cancelling = false;
  vi.restoreAllMocks();
});

const bar = () => render(StatusBar as never, {} as never);

describe("when nothing is running", () => {
  /*
    Present but empty. An operation starting is exactly when the user is looking here, and a strip that arrived
    at that moment would move the whole window under them as it did.
  */
  test("still stands, so nothing moves when an operation starts", () => {
    const view = bar();
    expect(view.all(".statusbar")).toHaveLength(1);
    expect(view.one(".statusbar").textContent?.trim()).toBe("");
    expect(view.all(".stop"), "and there is nothing to stop").toHaveLength(0);
  });
});

describe("while an operation runs", () => {
  test("names the step and keeps the proportion apart from it", () => {
    store.busy = "Installing Restoration Project Updated 2.3";
    store.progress = {
      step: "Downloading Restoration Project Updated 2.3 2.3.34",
      received: 289_000_000,
      total: 867_172_352,
      cancellable: true,
    };
    const view = bar();

    expect(view.one(".step").textContent).toBe("Downloading Restoration Project Updated 2.3 2.3.34");
    expect(view.one(".amount").textContent, "the half being watched, kept whole").toBe("33% of 827.0 MB");
  });

  /*
    The step is the only thing here whose length is a mod's rather than ours, so it is the only one allowed to
    give way. The proportion beside it is a dozen characters and must not be what a narrow window takes away.
  */
  test("lets only the step give way, since the amount is the bounded half", () => {
    store.busy = "Installing";
    store.progress = { step: "Downloading something with a very long name indeed", received: 1, total: 2 };
    const view = bar();

    expect(view.one(".step").className).toContain("step");
    expect(view.one(".step").getAttribute("title"), "the whole name is still reachable").toBe(
      "Downloading something with a very long name indeed",
    );
  });

  test("falls back to the operation's own name before any step has been reported", () => {
    store.busy = "Scanning";
    expect(bar().one(".step").textContent).toBe("Scanning");
  });
});

describe("stopping it", () => {
  test("offers the button only over a step a cancel would reach", () => {
    store.busy = "Installing";
    store.progress = { step: "Downloading", received: 1, total: 2, cancellable: true };
    expect(bar().all(".stop"), "while the bytes are moving").toHaveLength(1);

    unmountAll();
    store.progress = { step: "Installing the files", cancellable: false };
    expect(bar().all(".stop"), "and not once the transfer is done").toHaveLength(0);
  });

  test("asks the backend to stop, and says so while it unwinds", async () => {
    const asked = vi.spyOn(hostBackend, "cancel").mockResolvedValue(undefined);
    store.busy = "Installing";
    store.progress = { step: "Downloading", received: 1, total: 2, cancellable: true };
    const view = bar();

    view.one(".stop").click();
    await Promise.resolve();
    view.settle();

    expect(asked).toHaveBeenCalledTimes(1);
    expect(view.all(".stop"), "the button goes rather than being pressed twice").toHaveLength(0);
    expect(view.one(".stopping").textContent).toBe("Stopping...");
  });
});
