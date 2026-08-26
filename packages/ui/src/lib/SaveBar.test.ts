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

/** Autosave ships on, so a test of the Save button and its count turns it off the way the ZAX panel does. */
const byHand = () => store.setAutosave(false);

describe("the Save button", () => {
  test("is off with nothing changed, and says so in the chip beside it", async () => {
    await byHand();
    const view = render(SaveBar as never, {} as never);
    expect(view.control("Save").hasAttribute("disabled")).toBe(true);
    expect(view.text()).toContain("No changes");
  });

  test("comes on once a setting is edited, and the chip counts what is unsaved", async () => {
    await byHand();
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    const view = render(SaveBar as never, {} as never);
    expect(view.control("Save").hasAttribute("disabled")).toBe(false);
    expect(view.text()).toContain("1 unsaved");
  });

  test("saves through the store rather than writing anything itself", async () => {
    await byHand();
    const save = vi.spyOn(store, "save").mockResolvedValue(undefined);
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    render(SaveBar as never, {} as never)
      .control("Save")
      .click();
    expect(save).toHaveBeenCalledOnce();
  });

  /*
    Disabled rather than hidden under autosave, so the end of the bar does not shift as the setting is turned
    on and off. The title is what makes the refusal answerable - `ui-design.md` treats a disabled control with
    no explanation as a defect rather than a state.
  */
  test("is off under autosave, and the title says why", () => {
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    const view = render(SaveBar as never, {} as never);
    const save = view.control("Save");
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(save.getAttribute("title")).toMatch(/autosave/i);
  });

  /*
    The count and the Revert all are written within the debounce under autosave, so both would appear and
    vanish on every change. One standing chip instead: the flash was the whole of what they reported.
  */
  test("reports no unsaved count and offers no revert while autosave is on", () => {
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    const view = render(SaveBar as never, {} as never);
    expect(view.all("button.link").map((one) => (one.textContent ?? "").trim())).not.toContain("Revert all");
    expect(view.all(".chip").map((one) => (one.textContent ?? "").trim())).toEqual(["Saved automatically"]);
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

  test("puts every edited setting back, and takes itself away with them", async () => {
    await byHand();
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
  const CE = {
    id: "fallout2-ce",
    name: "Fallout II Community Edition",
    short: "CE",
    releases: "rolling",
    versions: [
      { release: "continious", published: "2026-08-23T09:37:22Z", commit: null },
      { release: "continious", published: "2026-07-01T00:00:00Z", commit: null },
    ],
  };

  const names = (view: ReturnType<typeof render>) => view.all("button").map((b) => b.textContent?.trim());

  test("are absent for an engine the machine holds no build of", () => {
    store.engines = [{ ...CE, versions: [] }] as never;
    expect(names(render(SaveBar as never, {} as never))).not.toContain("Run in CE");
  });

  /*
    Offered where the machine holds a build, not only where this folder already has one: one download serves
    every game folder, and the first run is what unpacks it in place.
  */
  test("appear for a build the machine holds, with nothing deployed in this folder", () => {
    store.engines = [CE] as never;
    store.engineDeployed = {};
    expect(names(render(SaveBar as never, {} as never))).toContain("Run in CE");
  });

  // One build is no choice, and a chevron over it would open a menu with a single row.
  test("offer no chooser while the machine holds one build", () => {
    store.engines = [{ ...CE, versions: CE.versions.slice(0, 1) }] as never;
    expect(render(SaveBar as never, {} as never).all('[aria-label="Choose a CE build"]')).toHaveLength(0);
  });

  test("offer the chooser once the machine holds two", () => {
    store.engines = [CE] as never;
    expect(render(SaveBar as never, {} as never).control("Choose a CE build")).toBeTruthy();
  });

  test("tick Latest while the folder is unpinned, and the build once it is pinned", () => {
    store.engines = [CE] as never;
    store.engineDeployed = {};
    const open = () => {
      const view = render(SaveBar as never, {} as never);
      view.control("Choose a CE build").click();
      view.settle();
      return view.all('[role="menuitem"].on').map((one) => one.textContent?.trim());
    };
    expect(open()).toEqual(["Latest"]);
    unmountAll();

    store.engineDeployed = {
      "fallout2-ce": {
        id: "fallout2-ce",
        release: "continious",
        published: "2026-07-01T00:00:00Z",
        complete: true,
        files: [],
        pinned: true,
      },
    };
    expect(open()).toEqual([new Date("2026-07-01T00:00:00Z").toLocaleDateString()]);
  });

  /*
    The rows launch, so in a host that cannot start a program they are refused - and say why, which is what this
    file exists to catch. The chooser itself stays live: opening a list of what the machine holds costs nothing.
  */
  test("refuse each build with the reason, while the chooser itself still opens", () => {
    store.engines = [CE] as never;
    const view = render(SaveBar as never, {} as never);
    view.control("Choose a CE build").click();
    view.settle();

    const items = view.all('[role="menuitem"]');
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.hasAttribute("disabled"), item.textContent ?? "").toBe(true);
      expect(item.getAttribute("title"), item.textContent ?? "").toMatch(/desktop build/i);
    }
  });
});
