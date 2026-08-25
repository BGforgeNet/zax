// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import SaveBar from "./SaveBar.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The bar that acts on the install rather than on any one view. Both of its buttons write through the store, and
  the interesting part is when each is refused: Save under autosave or with nothing changed, Run in a host that
  cannot start a program. A disabled button with no title is the failure worth catching - it says no without
  saying why.
*/

beforeEach(reseedPreview);
afterEach(() => {
  unmountAll();
  vi.restoreAllMocks();
});

const SETTING = "sfall.Misc.UseFileSystemOverride";

describe("the Save button", () => {
  test("is off with nothing changed, and says so in the chip beside it", () => {
    const view = render(SaveBar as never, {} as never);
    expect(view.control("Save").hasAttribute("disabled")).toBe(true);
    expect(view.text()).toContain("No changes");
  });

  test("comes on once a setting is edited, and the chip counts what is unsaved", () => {
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    const view = render(SaveBar as never, {} as never);
    expect(view.control("Save").hasAttribute("disabled")).toBe(false);
    expect(view.text()).toContain("1 unsaved");
  });

  test("saves through the store rather than writing anything itself", async () => {
    const save = vi.spyOn(store, "save").mockResolvedValue(undefined);
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    render(SaveBar as never, {} as never)
      .control("Save")
      .click();
    expect(save).toHaveBeenCalledOnce();
  });

  /*
    Disabled rather than hidden under autosave: a button that vanished would move Run under the pointer. The
    title is what makes the refusal answerable - `ui-design.md` treats a disabled control with no explanation as
    a defect rather than a state.
  */
  test("is off under autosave, and the title says why", async () => {
    await store.setAutosave(true);
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    const view = render(SaveBar as never, {} as never);
    const save = view.control("Save");
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(save.getAttribute("title")).toMatch(/autosave/i);
    await store.setAutosave(false);
  });
});

describe("the Run button", () => {
  test("is off in a host that cannot start a program, and the title says which host would", () => {
    const run = render(SaveBar as never, {} as never).control("Run");
    expect(run.hasAttribute("disabled")).toBe(true);
    expect(run.getAttribute("title")).toMatch(/desktop build/i);
  });
});

describe("the Revert all link", () => {
  test("is absent with nothing changed", () => {
    expect(render(SaveBar as never, {} as never).all("button.link")).toHaveLength(0);
  });

  test("puts every edited setting back, and takes itself away with them", () => {
    const before = store.valueOf(SETTING);
    store.set(SETTING, before === "1" ? "0" : "1");
    const view = render(SaveBar as never, {} as never);

    view.control("Revert all").click();
    view.settle();

    expect(store.valueOf(SETTING)).toBe(before);
    expect(store.modifiedCount).toBe(0);
    expect(view.all("button.link")).toHaveLength(0);
    expect(view.text()).toContain("No changes");
  });
});

describe("the per-engine Run buttons", () => {
  test("are absent for an engine that is neither installed here nor cached on the machine", () => {
    const view = render(SaveBar as never, {} as never);
    expect(view.all("button").map((b) => b.textContent?.trim())).not.toContain("Run in CE");
  });

  /*
    Offered where the machine holds a copy, not only where this folder already has one: one download serves every
    game folder, and the first run is what unpacks it in place.
  */
  test("appear for an engine held in the machine's cache, even with nothing installed in this folder", () => {
    store.engines = [
      { id: "fallout2-ce", name: "Fallout II Community Edition", short: "CE", installed: null, cached: true },
    ] as never;
    const view = render(SaveBar as never, {} as never);
    expect(view.all("button").map((b) => b.textContent?.trim())).toContain("Run in CE");
  });
});
