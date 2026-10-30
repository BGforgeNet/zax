// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import SettingRow from "./SettingRow.svelte";
import { bytes, catalogDef, disk, PREVIEW_INSTALL, render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  One line of the settings list, and the place every note about a value lands: that it is not in the file, that
  a gate holds it inert, that it clashes with another setting, that it was carried over from somewhere else.
  Each of those is a claim about the install, so a row that draws the wrong one is worse than a row that draws
  nothing.
*/

const PRESENT = "sfall.Misc.ProcessorIdle";
const BOOL = "sfall.Misc.UseFileSystemOverride";

beforeEach(reseedPreview);
afterEach(unmountAll);

const row = (id: string, props: Record<string, unknown> = {}) =>
  render(SettingRow as never, { def: catalogDef(id), ...props } as never);

/** An edit, answered and on screen. */
const set = async (id: string, value: string) => {
  store.set(id, value);
  await store.idle();
};

describe("what the row names", () => {
  test("shows the catalog's label, with the exact key behind it on hover", () => {
    const view = row(PRESENT);
    expect(view.one(".name").textContent).toBe(catalogDef(PRESENT).label);
    // File, section and key in full: that is what makes the row checkable against the file itself.
    expect(view.one(".name").getAttribute("title")).toBe("ddraw.ini [Misc] ProcessorIdle");
  });

  test("shows the catalog's help where there is any", () => {
    expect(row(PRESENT).one(".help").textContent).toBe(catalogDef(PRESENT).help);
  });
});

describe("a value that is not in the file", () => {
  /*
    A row marked changed with nothing on screen saying why reads as ZAX having edited the install on its own, so
    the absent note and the modified mark are mutually exclusive by construction.
  */
  test("says the game uses its default", () => {
    expect(row("sfall.Misc.SaveInCombatFix").text()).toContain("not in your config");
  });

  test("stops saying so once the user sets it", async () => {
    await set("sfall.Misc.SaveInCombatFix", "2");
    expect(row("sfall.Misc.SaveInCombatFix").text()).not.toContain("not in your config");
  });
});

describe("an edited value", () => {
  test("marks the row and offers a revert that puts it back", async () => {
    // The revert control belongs to saving by hand; the reseed turns autosave off for exactly this.
    const before = store.valueOf(BOOL);
    await set(BOOL, before === "1" ? "0" : "1");
    const view = row(BOOL);

    expect(view.one(".row").classList.contains("modified")).toBe(true);
    view.control("revert").click();
    await store.idle();
    view.settle();

    expect(store.valueOf(BOOL)).toBe(before);
    expect(view.all("button.revert")).toHaveLength(0);
  });

  test("offers no revert while nothing is changed", () => {
    expect(row(BOOL).all("button.revert")).toHaveLength(0);
  });

  /*
    Under autosave the edit is written within the debounce, so this control would appear and vanish as the
    pointer reached it. The row's colour still marks the change, which is the feedback autosave leaves.
  */
  test("offers no revert under autosave, though the row still marks the change", async () => {
    await store.setAutosave(true);
    const before = store.valueOf(BOOL);
    await set(BOOL, before === "1" ? "0" : "1");
    const view = row(BOOL);
    expect(view.one(".row").classList.contains("modified")).toBe(true);
    expect(view.all("button.revert")).toHaveLength(0);
  });
});

describe("a value ZAX pins", () => {
  /*
    A pinned setting is drawn as its value rather than as a control: an editable control would let the user
    fight a value ZAX is going to rewrite.
  */
  test("is shown as text with its reason, and draws no control at all", () => {
    const pinned = store.catalog?.settings.find((setting) => setting.managed !== null);
    if (!pinned?.managed) throw new Error("no setting in this catalog is pinned - the state this row draws is gone");
    const view = render(SettingRow as never, { def: pinned } as never);
    expect(view.all(".pinned")).toHaveLength(1);
    expect(view.all("fieldset")).toHaveLength(0);
    expect(view.text()).toContain(pinned.managed.reason);
  });
});

describe("a row whose file is in the game folder", () => {
  test("keeps the setting on screen and takes input", () => {
    const view = row("sfall.Misc.ProcessorIdle");
    expect(view.all("fieldset")).toHaveLength(1);
    expect(view.one<HTMLFieldSetElement>("fieldset").disabled).toBe(false);
  });
});

describe("a search result", () => {
  /*
    `where` is set only by the search results, where a row has been lifted out of the tab that located it. With
    a handler it is the way back; without one it is just the address, and must not look clickable.
  */
  test("carries a badge that navigates back to the tab the setting lives on", () => {
    let went = 0;
    const view = row(PRESENT, { where: "Sfall / Main / Misc", onGo: () => (went += 1) });
    view.one("button.badge.go").click();
    expect(went).toBe(1);
  });

  test("draws the address as plain text when there is nowhere to go", () => {
    const view = row(PRESENT, { where: "Sfall / Main / Misc" });
    expect(view.all("button.badge")).toHaveLength(0);
    expect(view.one("span.badge").textContent).toBe("Sfall / Main / Misc");
  });
});

describe("a setting more than one engine carries", () => {
  /** A catalog setting whose other addresses all belong to one engine, and that address. */
  const sharedWith = (engine: string) => {
    for (const setting of store.catalog?.settings ?? []) {
      const others = setting.targets.slice(1);
      const target = others[0];
      if (target && others.every((one) => one.engine === engine)) return { def: setting, target };
    }
    throw new Error(`the catalog no longer carries a setting only ${engine} shares`);
  };

  /*
    The mark distinguishes, which is the whole reason it is worth drawing: an engine that is not installed here
    gets none. The seeded install has Fission deployed and fallout2-ce not.
  */
  test("carries no mark while the other engine is not installed here", () => {
    const view = render(SettingRow as never, { def: sharedWith("fallout2-ce").def } as never);
    expect(view.all("[role=img]")).toHaveLength(0);
    expect(view.one(".mark").getAttribute("aria-hidden")).toBe("true");
  });

  test("carries a mark naming the other address in full once that engine has written its settings", async () => {
    const shared = sharedWith("fission");
    disk().writeFile(`${PREVIEW_INSTALL}/fission.cfg`, bytes("[enhancements]\n"));
    await store.start();
    const view = render(SettingRow as never, { def: shared.def } as never);
    const name = view.one("[role=img]").getAttribute("aria-label") ?? "";
    expect(name).toContain("The same value is written to");
    // File, section and key: the point of the note is that a reader can check it against the file.
    expect(name).toContain(`${shared.target.file} [${shared.target.section}] ${shared.target.key}`);
    expect(name).not.toContain("not until that engine has run");
  });

  /*
    Installed but not yet run is a third state, and it is flagged rather than dropped: the link is real and about
    to matter.
  */
  test("says the link is not yet live where that engine has written no settings", () => {
    const view = render(SettingRow as never, { def: sharedWith("fission").def } as never);
    expect(view.one("[role=img]").getAttribute("aria-label")).toContain("not until that engine has run");
  });

  test("leaves the mark slot empty and hidden for a setting only one file carries", () => {
    const only = store.catalog?.settings.find((setting) => setting.targets.length === 1);
    if (!only) throw new Error("the catalog no longer carries a single-address setting");
    const view = render(SettingRow as never, { def: only } as never);
    expect(view.all("[role=img]")).toHaveLength(0);
    expect(view.one(".mark").getAttribute("aria-hidden")).toBe("true");
  });
});

describe("an invalid value", () => {
  test("is called out as an alert rather than only styled", async () => {
    await set(PRESENT, "not-a-number");
    const alert = row(PRESENT).one("[role=alert]");
    expect(alert.textContent).toContain("Not a number");
  });
});

describe("a sentinel value", () => {
  test("says what the number means rather than leaving the user to read -1", async () => {
    await set(PRESENT, "-1");
    expect(row(PRESENT).text()).toContain("Disabled");
  });
});
