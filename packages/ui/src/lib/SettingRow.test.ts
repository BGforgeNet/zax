// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SETTINGS } from "@zax/fallout2";
import type { SettingDef } from "@zax/core";
import SettingRow from "./SettingRow.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  One line of the settings list, and the place every note about a value lands: that it is not in the file, that
  a gate holds it inert, that it clashes with another setting, that it was carried over from somewhere else.
  Each of those is a claim about the install, so a row that draws the wrong one is worse than a row that draws
  nothing - and none of them is visible to a test of the store alone.
*/

const def = (id: string): SettingDef => {
  const found = SETTINGS.find((setting) => setting.id === id);
  if (!found) throw new Error(`no catalog setting "${id}" - the id it was written against was renamed`);
  return found;
};

const PRESENT = "sfall.Misc.ProcessorIdle";
const BOOL = "sfall.Misc.UseFileSystemOverride";

beforeEach(reseedPreview);
afterEach(unmountAll);

const row = (id: string, props: Record<string, unknown> = {}) =>
  render(SettingRow as never, { def: def(id), ...props } as never);

describe("what the row names", () => {
  test("shows the catalog's label, with the exact key behind it on hover", () => {
    const view = row(PRESENT);
    expect(view.one(".name").textContent).toBe(def(PRESENT).label);
    // File, section and key in full: that is what makes the row checkable against the file itself.
    expect(view.one(".name").getAttribute("title")).toBe("ddraw.ini [Misc] ProcessorIdle");
  });

  test("shows the catalog's help where there is any", () => {
    expect(row(PRESENT).one(".help").textContent).toBe(def(PRESENT).help);
  });
});

describe("a value that is not in the file", () => {
  /*
    A row marked changed with nothing on screen saying why reads as ZAX having edited the install on its own, so
    the absent note and the modified mark are mutually exclusive by construction.
  */
  test("says the game uses its default", () => {
    const view = row("sfall.Misc.SaveInCombatFix");
    expect(view.text()).toContain("not in your config");
  });

  test("stops saying so once the user sets it", () => {
    store.set("sfall.Misc.SaveInCombatFix", "2");
    const view = row("sfall.Misc.SaveInCombatFix");
    expect(view.text()).not.toContain("not in your config");
  });
});

describe("an edited value", () => {
  test("marks the row and offers a revert that puts it back", () => {
    const before = store.valueOf(BOOL);
    store.set(BOOL, before === "1" ? "0" : "1");
    const view = row(BOOL);

    expect(view.one(".row").classList.contains("modified")).toBe(true);
    view.control("revert").click();
    view.settle();

    expect(store.valueOf(BOOL)).toBe(before);
    expect(view.all("button.revert")).toHaveLength(0);
  });

  test("offers no revert while nothing is changed", () => {
    expect(row(BOOL).all("button.revert")).toHaveLength(0);
  });
});

describe("a value ZAX pins", () => {
  /*
    A pinned setting is drawn as its value rather than as a control: it counts as a pending change, so hiding it
    would leave an unsaved count the user can neither find nor revert - and an editable control would let them
    fight a value ZAX is going to rewrite.
  */
  test("is shown as text with its reason, and draws no control at all", () => {
    const managed = SETTINGS.find((setting) => setting.managed);
    if (!managed) return; // No setting is pinned in this catalog; nothing to assert.
    const view = render(SettingRow as never, { def: managed } as never);
    expect(view.all(".pinned")).toHaveLength(1);
    expect(view.all("fieldset")).toHaveLength(0);
    expect(view.text()).toContain(managed.managed!.reason);
  });
});

describe("a row whose file is not in the game folder", () => {
  test("keeps the setting on screen but refuses input", () => {
    // f2_res.ini is absent from an install with no hi-res patch; the fixture has one, so drive the other way.
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
  /** A catalog row whose second address belongs to an engine, and that engine's id. */
  const shared = (() => {
    for (const setting of SETTINGS) {
      const other = setting.targets.slice(1).find((target) => target.engine !== undefined);
      if (other) return { def: setting, engine: other.engine!, target: other };
    }
    throw new Error("the catalog no longer carries a setting an engine shares");
  })();

  const installed = (live: boolean) => {
    store.engines = [
      { id: shared.engine, name: shared.engine, short: shared.engine, installed: { id: shared.engine }, cached: true },
    ] as never;
    if (live) store.contents = { ...store.contents, [shared.target.file]: "" };
  };

  /*
    The mark distinguishes, which is the whole reason it is worth drawing: an engine that is not installed here
    gets none, because saying "this is also written to software that is not on this machine" would say nothing
    about this install.
  */
  test("carries no mark while the other engine is not installed here", () => {
    const view = render(SettingRow as never, { def: shared.def } as never);
    expect(view.all("[role=img]")).toHaveLength(0);
    expect(view.one(".mark").getAttribute("aria-hidden")).toBe("true");
  });

  test("carries a mark naming the other address in full once that engine is installed", () => {
    installed(true);
    const view = render(SettingRow as never, { def: shared.def } as never);
    const name = view.one("[role=img]").getAttribute("aria-label") ?? "";
    expect(name).toContain("The same value is written to");
    // File, section and key: the point of the note is that a reader can check it against the file.
    expect(name).toContain(shared.target.file);
    expect(name).toContain(shared.target.section);
    expect(name).toContain(shared.target.key);
  });

  /*
    Installed but not yet run is a third state, and it is flagged rather than dropped: the link is real and about
    to matter, so claiming the value goes somewhere ZAX is deliberately leaving alone would be a lie the other
    way round.
  */
  test("says the link is not yet live where that engine has written no settings", () => {
    installed(false);
    const view = render(SettingRow as never, { def: shared.def } as never);
    expect(view.one("[role=img]").getAttribute("aria-label")).toContain("not until that engine has run");
  });

  test("leaves the mark slot empty and hidden for a setting only one file carries", () => {
    const only = SETTINGS.find((setting) => setting.targets.length === 1);
    if (!only) throw new Error("the catalog no longer carries a single-address setting");
    const view = render(SettingRow as never, { def: only } as never);
    expect(view.all("[role=img]")).toHaveLength(0);
    expect(view.one(".mark").getAttribute("aria-hidden")).toBe("true");
  });
});

describe("an invalid value", () => {
  test("is called out as an alert rather than only styled", () => {
    store.set(PRESENT, "not-a-number");
    const view = row(PRESENT);
    const alert = view.one("[role=alert]");
    expect(alert.textContent).toContain("Not a number");
  });
});

describe("a sentinel value", () => {
  test("says what the number means rather than leaving the user to read -1", () => {
    store.set(PRESENT, "-1");
    expect(row(PRESENT).text()).toContain("Disabled");
  });
});
