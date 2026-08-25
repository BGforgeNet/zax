// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEBUG_PACKAGE_CONTENTS } from "@zax/fallout2";
import BugReportPanel from "./BugReportPanel.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  A report is a sequence you work through, and the panel's job is to keep the order: turn logging on, run the
  game, collect, file. The savegame picker is the part with rules of its own - slots are opted into rather than
  swept in, since they are the largest thing in the archive and the one part a user may not want to hand over.
*/

const SLOTS = ["SLOT01 - Arroyo", "SLOT02 - Klamath", "SLOT03 - Den"];

beforeEach(async () => {
  await reseedPreview();
  store.busy = null;
});
afterEach(() => {
  unmountAll();
  store.busy = null;
  vi.restoreAllMocks();
});

const withSlots = async (slots: readonly string[] = SLOTS) => {
  vi.spyOn(store, "saveSlots").mockResolvedValue(slots);
  const view = render(BugReportPanel as never, {} as never);
  // The slot list is read in an effect, so the first frame has none; let it land before asserting.
  await vi.waitFor(() => expect(view.text()).not.toContain("No savegames found"));
  view.settle();
  return view;
};

describe("the steps", () => {
  test("lists the four in the order they have to happen", async () => {
    const view = await withSlots();
    const steps = view.all("ol.steps > li").map((li) => (li.textContent ?? "").replace(/\s+/g, " "));
    expect(steps).toHaveLength(4);
    expect(steps[0]).toContain("Turn on every log");
    expect(steps[1]).toContain("reproduce the problem");
    expect(steps[2]).toContain("Collect the logs");
    expect(steps[3]).toContain("File the report");
  });

  test("says where the game's own logs are written, since they are not written here", async () => {
    expect((await withSlots()).text()).toContain("written next to the game");
  });

  /* Taken from the domain rather than listed in the view, so the archive and the promise cannot drift. */
  test("names everything the archive carries", async () => {
    const text = (await withSlots()).text();
    for (const item of DEBUG_PACKAGE_CONTENTS) expect(text).toContain(item);
  });
});

describe("the savegame picker", () => {
  test("says none were found rather than offering an empty dialog", async () => {
    vi.spyOn(store, "saveSlots").mockResolvedValue([]);
    const view = render(BugReportPanel as never, {} as never);
    await vi.waitFor(() => expect(view.text()).toContain("No savegames found"));
    expect(view.one("button.picker").hasAttribute("disabled")).toBe(true);
  });

  test("counts what is there before anything is chosen", async () => {
    expect((await withSlots()).one("button.picker").textContent).toContain(`Choose savegames (${SLOTS.length})`);
  });

  test("opens the list behind the button, one checkbox per slot", async () => {
    const view = await withSlots();
    view.one("button.picker").click();
    view.settle();
    expect(view.all("input[type=checkbox]")).toHaveLength(SLOTS.length);
  });

  test("counts what has been chosen against what is there", async () => {
    const view = await withSlots();
    view.one("button.picker").click();
    view.settle();

    view.all<HTMLInputElement>("input[type=checkbox]")[1]!.click();
    view.settle();

    expect(view.one("button.picker").textContent).toContain(`1 of ${SLOTS.length}`);
  });

  test("filters by what the player typed, case-insensitively", async () => {
    const view = await withSlots();
    view.one("button.picker").click();
    view.settle();

    const filter = view.one<HTMLInputElement>("input.filter");
    filter.value = "klamath";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    view.settle();

    expect(view.all("input[type=checkbox]")).toHaveLength(1);
    expect(view.text()).toContain("Klamath");
  });

  test("says what matched nothing rather than showing an empty list", async () => {
    const view = await withSlots();
    view.one("button.picker").click();
    view.settle();

    const filter = view.one<HTMLInputElement>("input.filter");
    filter.value = "zzzz";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    view.settle();

    expect(view.text()).toContain('Nothing matches "zzzz"');
  });

  /* Acts on what the filter is showing, which is what "all" means with a filter in the box. */
  test("Select all takes only what the filter is showing", async () => {
    const view = await withSlots();
    view.one("button.picker").click();
    view.settle();

    const filter = view.one<HTMLInputElement>("input.filter");
    filter.value = "klamath";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    view.settle();

    view.control("Select all").click();
    view.settle();

    filter.value = "";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    view.settle();

    expect(view.one("button.picker").textContent).toContain(`1 of ${SLOTS.length}`);
  });

  test("Select none clears only what the filter is showing", async () => {
    const view = await withSlots();
    view.one("button.picker").click();
    view.settle();

    view.control("Select all").click();
    view.settle();
    expect(view.one("button.picker").textContent).toContain(`${SLOTS.length} of ${SLOTS.length}`);

    const filter = view.one<HTMLInputElement>("input.filter");
    filter.value = "klamath";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    view.settle();
    view.control("Select none").click();
    view.settle();

    filter.value = "";
    filter.dispatchEvent(new Event("input", { bubbles: true }));
    view.settle();
    expect(view.one("button.picker").textContent).toContain(`${SLOTS.length - 1} of ${SLOTS.length}`);
  });
});

describe("creating the archive", () => {
  test("passes exactly the chosen slots, not every slot found", async () => {
    const create = vi.spyOn(store, "createDebugPackage").mockResolvedValue(undefined);
    const view = await withSlots();

    view.one("button.picker").click();
    view.settle();
    view.all<HTMLInputElement>("input[type=checkbox]")[2]!.click();
    view.settle();
    view.control("Done").click();
    view.settle();

    view.one("button.package").click();
    expect(create).toHaveBeenCalledExactlyOnceWith([SLOTS[2]]);
  });

  test("says what it is doing while it collects", async () => {
    const view = await withSlots();
    store.busy = "Creating the debug package";
    view.settle();
    expect(view.text()).toContain("Collecting...");
  });
});

describe("turning logging back off", () => {
  /* Logging costs performance, so the panel offers the way back only once it is actually on. */
  test("is not offered while logging is off", async () => {
    expect((await withSlots()).text()).not.toContain("turn it back off");
  });

  test("is offered once the enable action has been applied", async () => {
    const view = await withSlots();
    const enable = store.actionById("debug.enable");
    if (!enable) throw new Error("the catalog no longer defines debug.enable");
    store.applyAction(enable);
    view.settle();
    expect(view.text()).toContain("turn it back off once the report is filed");
  });
});
