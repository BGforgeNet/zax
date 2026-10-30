// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import SfallVersion from "./SfallVersion.svelte";
import { plantLibrary, render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The sfall block as the desktop draws it: the check and the change of version are live there, and what is under
  test is the flow each button opens and what it asks the store for. Every store call that would reach the
  release feed is spied on.
*/
vi.mock("./invoke.js", async (importOriginal) => ({ ...(await importOriginal<object>()), isPreview: false }));

beforeEach(async () => {
  await reseedPreview();
  await plantLibrary("ddraw.dll", "4.4.6");
});
afterEach(() => {
  unmountAll();
  store.busy = null;
  vi.restoreAllMocks();
});

const block = () => render(SfallVersion as never, {} as never);

/**
 * Picks a version in the open dialog. Svelte's select binding reads the choice back with `:checked`, which
 * happy-dom matches on no option, and then falls back to the first option not disabled - so the others are
 * disabled for the moment the change is read, which leaves that fallback naming the one picked.
 */
const pick = (view: ReturnType<typeof block>, version: string) => {
  const select = view.one<HTMLSelectElement>("dialog[open] select");
  const others = [...select.options].filter((option) => option.value !== version);
  for (const option of others) option.disabled = true;
  select.value = version;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  for (const option of others) option.disabled = false;
  view.settle();
};

describe("on the desktop", () => {
  test("Check asks the store for the latest release", () => {
    const check = vi.spyOn(store, "checkSfallVersion").mockResolvedValue(undefined);
    block().control("Check").click();
    expect(check).toHaveBeenCalledOnce();
  });

  test("Update replaces the installed sfall once a newer one is known", () => {
    const update = vi.spyOn(store, "updateSfall").mockResolvedValue(undefined);
    vi.spyOn(store, "sfallOutdated", "get").mockReturnValue(true);
    block().control("Update").click();
    expect(update).toHaveBeenCalledOnce();
  });

  test("Change version opens the list starting on the installed version, and reads the list", () => {
    const load = vi.spyOn(store, "loadSfallVersions").mockResolvedValue(undefined);
    store.sfallVersions = ["4.4.6", "4.4.5"];
    const view = block();
    view.control("Change version").click();
    view.settle();
    expect(load).toHaveBeenCalledOnce();
    expect(view.one<HTMLSelectElement>("dialog[open] select").value).toBe("4.4.6");
    // Applying the version already installed changes nothing, so it is not offered.
    expect(view.control("Apply").hasAttribute("disabled")).toBe(true);
  });

  test("Apply changes to the version picked, saying which, and closes the dialog once it has", async () => {
    vi.spyOn(store, "loadSfallVersions").mockResolvedValue(undefined);
    const change = vi.spyOn(store, "changeSfall").mockResolvedValue(undefined);
    store.sfallVersions = ["4.4.6", "4.4.5"];
    const view = block();
    view.control("Change version").click();
    view.settle();

    pick(view, "4.4.5");
    view.control("Apply").click();
    await vi.waitFor(() => expect(view.all("dialog[open]")).toHaveLength(0));
    expect(change).toHaveBeenCalledExactlyOnceWith("4.4.5", "Changing sfall to 4.4.5");
  });

  test("Cancel closes the dialog without changing anything", () => {
    vi.spyOn(store, "loadSfallVersions").mockResolvedValue(undefined);
    const change = vi.spyOn(store, "changeSfall");
    const view = block();
    view.control("Change version").click();
    view.settle();
    view.control("Cancel").click();
    view.settle();
    expect(view.all("dialog[open]")).toHaveLength(0);
    expect(change).not.toHaveBeenCalled();
  });

  test("says what the change is doing while it runs", () => {
    vi.spyOn(store, "loadSfallVersions").mockResolvedValue(undefined);
    store.sfallVersions = ["4.4.6", "4.4.5"];
    const view = block();
    view.control("Change version").click();
    view.settle();
    pick(view, "4.4.5");
    store.busy = "Changing sfall to 4.4.5";
    view.settle();
    expect(view.control("Applying...").hasAttribute("disabled")).toBe(true);
  });
});
