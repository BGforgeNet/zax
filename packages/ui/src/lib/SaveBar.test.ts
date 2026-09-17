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

/** Saving by hand, as the reseed leaves it - named at each case that depends on it. */
const byHand = async () => store.setAutosave(false);

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
    await store.idle();
    const view = render(SaveBar as never, {} as never);
    expect(view.control("Save").hasAttribute("disabled")).toBe(false);
    expect(view.text()).toContain("1 unsaved");
  });

  test("saves through the store rather than writing anything itself", async () => {
    await byHand();
    const save = vi.spyOn(store, "save").mockResolvedValue(undefined);
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    await store.idle();
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
  test("is off under autosave, and the title says why", async () => {
    await store.setAutosave(true);
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    await store.idle();
    const view = render(SaveBar as never, {} as never);
    const save = view.control("Save");
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(save.getAttribute("title")).toMatch(/autosave/i);
  });

  /*
    The count and the Revert all are written within the debounce under autosave, so both would appear and
    vanish on every change. One standing chip instead: the flash was the whole of what they reported.
  */
  test("reports no unsaved count and offers no revert while autosave is on", async () => {
    await store.setAutosave(true);
    store.set(SETTING, store.valueOf(SETTING) === "1" ? "0" : "1");
    await store.idle();
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
    await store.idle();
    const view = render(SaveBar as never, {} as never);

    view.control("Revert all").click();
    await store.idle();
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
    vi.spyOn(store, "engines", "get").mockReturnValue([{ ...CE, versions: [] }] as never);
    expect(names(render(SaveBar as never, {} as never))).not.toContain("Run in CE");
  });

  /*
    Offered where the machine holds a build, not only where this folder already has one: one download serves
    every game folder, and the first run is what unpacks it in place.
  */
  test("appear for a build the machine holds, with nothing deployed in this folder", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([CE] as never);
    expect(names(render(SaveBar as never, {} as never))).toContain("Run in CE");
  });

  // One build is no choice, and a chevron over it would open a menu with a single row.
  test("offer no chooser while the machine holds one build", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([{ ...CE, versions: CE.versions.slice(0, 1) }] as never);
    expect(render(SaveBar as never, {} as never).all('[aria-label="Choose a CE build"]')).toHaveLength(0);
  });

  test("offer the chooser once the machine holds two", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([CE] as never);
    expect(render(SaveBar as never, {} as never).control("Choose a CE build")).toBeTruthy();
  });

  test("tick Latest while the folder is unpinned, and the build once it is pinned", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([CE] as never);
    const open = () => {
      const view = render(SaveBar as never, {} as never);
      view.control("Choose a CE build").click();
      view.settle();
      return view.all('[role="menuitem"].on').map((one) => one.textContent?.trim());
    };
    expect(open()).toEqual(["Latest"]);
    unmountAll();

    vi.spyOn(store, "engineDeployed", "get").mockReturnValue({
      "fallout2-ce": {
        id: "fallout2-ce",
        release: "continious",
        published: "2026-07-01T00:00:00Z",
        complete: true,
        files: [],
        backup: null,
        commit: null,
        pinned: true,
      },
    });
    expect(open()).toEqual([new Date("2026-07-01T00:00:00Z").toLocaleDateString()]);
  });

  /*
    The rows launch, so in a host that cannot start a program they are refused - and say why, which is what this
    file exists to catch. The chooser itself stays live: opening a list of what the machine holds costs nothing.
  */
  test("name a tagged project's builds by their tag rather than by a date", () => {
    const tagged = {
      ...CE,
      releases: "tagged",
      versions: [
        { release: "beta-0.9.6.8", published: "2026-08-01T00:00:00Z", commit: null },
        { release: "beta-0.9.6.7", published: "2026-07-01T00:00:00Z", commit: null },
      ],
    };
    vi.spyOn(store, "engines", "get").mockReturnValue([tagged] as never);
    const view = render(SaveBar as never, {} as never);
    view.control("Choose a CE build").click();
    view.settle();
    expect(view.all('[role="menuitem"]').map((one) => one.textContent?.trim())).toEqual([
      "Latest",
      "beta-0.9.6.8",
      "beta-0.9.6.7",
    ]);
  });

  // Anywhere outside closes it, which is the only way to dismiss a menu without picking from it.
  test("close the chooser on a press outside it, and keep it open on a press inside", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([CE] as never);
    const view = render(SaveBar as never, {} as never);
    view.control("Choose a CE build").click();
    view.settle();

    view.one('[role="menu"]').dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    view.settle();
    expect(view.all('[role="menu"]')).toHaveLength(1);

    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    view.settle();
    expect(view.all('[role="menu"]')).toHaveLength(0);
    expect(view.control("Choose a CE build").getAttribute("aria-expanded")).toBe("false");
  });

  test("close the chooser when its own button is pressed again", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([CE] as never);
    const view = render(SaveBar as never, {} as never);
    view.control("Choose a CE build").click();
    view.settle();
    view.control("Choose a CE build").click();
    view.settle();
    expect(view.all('[role="menu"]')).toHaveLength(0);
  });

  test("refuse each build with the reason, while the chooser itself still opens", () => {
    vi.spyOn(store, "engines", "get").mockReturnValue([CE] as never);
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

/*
  The dialog a launch waits behind. What it holds is set on the store directly: the preview cannot start a
  program, so it never reaches the point where a real launch would be held - and what is under test here is what
  the dialog says about whichever it was given.
*/
describe("the launch dialog", () => {
  const FISSION = {
    id: "fission",
    name: "Fallout Fission",
    short: "Fission",
    page: "https://github.com/cambragol/fission-ce",
    releases: "tagged",
    build: null,
    why: null,
    caution: "Fission does not read the sfall load order.",
    versions: [],
  } as const;

  const hold = (launch: Partial<NonNullable<typeof store.pendingLaunch>>) => {
    store.pendingLaunch = { engine: null, caution: null, pick: null, missed: [], swap: null, ...launch } as never;
  };

  afterEach(() => {
    store.pendingLaunch = null;
  });

  test("is titled after the engine the launch is for, or after the game where there is none", () => {
    hold({ engine: FISSION as never, caution: FISSION.caution });
    const view = render(SaveBar as never, {} as never);
    expect(view.one("dialog[open]").textContent).toContain("Run in Fission");
    store.pendingLaunch = null;
    view.settle();
    hold({ swap: { from: "fission", to: "sfall", losing: [], gaining: [] } });
    view.settle();
    expect(view.one("dialog[open]").textContent).toContain("Run the game");
  });

  test("says the caution, and records the box only when it was ticked", async () => {
    const confirm = vi.spyOn(store, "confirmLaunch").mockResolvedValue(undefined);
    hold({ engine: FISSION as never, caution: FISSION.caution });
    const view = render(SaveBar as never, {} as never);
    expect(view.text()).toContain("Fission does not read the sfall load order.");
    expect(view.text()).toContain("Fallout Fission handles mods its own way");

    view.control("Run anyway").click();
    expect(confirm).toHaveBeenLastCalledWith(false);

    view.one<HTMLInputElement>(".understood input").click();
    view.settle();
    view.control("Run anyway").click();
    expect(confirm).toHaveBeenLastCalledWith(true);
  });

  test("offers no box to tick where nothing is cautioned", () => {
    hold({ swap: { from: "sfall", to: "fission", losing: [], gaining: [] } });
    const view = render(SaveBar as never, {} as never);
    expect(view.all(".understood")).toHaveLength(0);
  });

  test("names the formats a swap moves between, and says so when the same mods load either way", () => {
    hold({ engine: FISSION as never, swap: { from: "sfall", to: "fission", losing: [], gaining: [] } });
    const view = render(SaveBar as never, {} as never);
    expect(view.text()).toContain("This game was last set up for sfall. Running Fission swaps the mod order over");
    expect(view.text()).toContain("puts Fission's back");
    expect(view.text()).toContain("The same mods load either way.");
  });

  test("lists what a swap stops loading and what it starts, each under its own heading", () => {
    hold({
      engine: FISSION as never,
      swap: { from: "sfall", to: "fission", losing: ["weapon_sounds.dat", "hero_appearance"], gaining: ["mod_x.dat"] },
    });
    const view = render(SaveBar as never, {} as never);
    const columns = view.all(".swap-cols > div").map((column) => ({
      head: column.querySelector(".swap-head")?.textContent?.trim(),
      names: [...column.querySelectorAll(".missed-name")].map((name) => name.textContent?.trim()),
    }));
    expect(columns).toEqual([
      { head: "No longer loads", names: ["weapon_sounds.dat", "hero_appearance"] },
      { head: "Starts loading", names: ["mod_x.dat"] },
    ]);
    expect(view.text()).not.toContain("The same mods load either way.");
  });

  test("leaves out a column the swap has nothing for", () => {
    hold({ swap: { from: "fission", to: "sfall", losing: [], gaining: ["weapon_sounds.dat"] } });
    const view = render(SaveBar as never, {} as never);
    expect(view.all(".swap-head").map((head) => head.textContent?.trim())).toEqual(["Starts loading"]);
  });

  test("counts and lists the entries that will not load at all, in the singular for one", () => {
    const entry = (name: string) => ({ name, enabled: true, kind: "folder", owner: null });
    hold({ engine: FISSION as never, caution: FISSION.caution, missed: [entry("hero_appearance")] as never });
    const view = render(SaveBar as never, {} as never);
    expect(view.text()).toContain("One entry in the mods folder will not load at all:");
    store.pendingLaunch = null;
    view.settle();

    hold({ engine: FISSION as never, caution: FISSION.caution, missed: [entry("a"), entry("b")] as never });
    view.settle();
    expect(view.text()).toContain("2 entries in the mods folder will not load at all:");
    expect(view.all("dialog[open] .missed-kind").map((kind) => kind.textContent)).toEqual(["folder", "folder"]);
  });

  test("goes away on Cancel without launching", () => {
    const confirm = vi.spyOn(store, "confirmLaunch");
    hold({ engine: FISSION as never, caution: FISSION.caution });
    const view = render(SaveBar as never, {} as never);
    view.control("Cancel").click();
    view.settle();
    expect(store.pendingLaunch).toBeNull();
    expect(view.all("dialog[open]")).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
  });
});
