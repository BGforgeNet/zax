// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { SETTINGS } from "@zax/fallout2";
import type { SettingDef } from "@zax/core";
import Control from "./Control.svelte";
import { render, reseedPreview, unmountAll } from "./preview-fixture.js";
import { store } from "./store.svelte.js";

/*
  The one control that has to read every setting kind the catalog defines. Its branches are what decides whether
  a user sees a toggle, a slider or a key capture, and each writes back through `store.set` in a different
  shape - a percent folded to the engine's own scale, a scancode from a physical key, a float at the file's
  precision. Every case below drives a real catalog definition rather than a hand-made one, so a kind whose
  shape changes upstream fails here instead of rendering the wrong widget.
*/

const def = (id: string): SettingDef => {
  const found = SETTINGS.find((setting) => setting.id === id);
  if (!found) throw new Error(`no catalog setting "${id}" - the id it was written against was renamed`);
  return found;
};

const BOOL = "sfall.Misc.UseFileSystemOverride";
const CHOICE = "sfall.Misc.DamageFormula";
const BOUNDED_INT = "sfall.Misc.CorpseDeleteTime";
const KEY = "sfall.Input.ReloadWeaponKey";
const SCALE = "game.sound.master_volume";
const FLOAT = "game.preferences.brightness";
const TEXT = "game.system.critter_dat";

beforeEach(reseedPreview);
afterEach(unmountAll);

const draw = (id: string, control?: string) =>
  render(Control as never, (control === undefined ? { def: def(id) } : { def: def(id), control }) as never);

describe("a boolean setting", () => {
  test("draws a switch that reports its state to a screen reader", () => {
    store.set(BOOL, "0");
    const view = draw(BOOL);
    expect(view.one("[role=switch]").getAttribute("aria-checked")).toBe("false");
  });

  test("writes the catalog's own on-value rather than a literal true", () => {
    store.set(BOOL, "0");
    const view = draw(BOOL);
    view.one("[role=switch]").click();
    expect(store.valueOf(BOOL)).toBe("1");
  });

  test("toggles back to the off-value", () => {
    store.set(BOOL, "1");
    const view = draw(BOOL);
    view.one("[role=switch]").click();
    expect(store.valueOf(BOOL)).toBe("0");
  });
});

describe("a choice setting", () => {
  test("draws one option per catalog option, labelled as the catalog labels them", () => {
    const view = draw(CHOICE);
    const kind = def(CHOICE).kind;
    if (kind.type !== "choice") throw new Error("the fixture setting stopped being a choice");
    expect(view.all("option").map((o) => o.textContent)).toEqual(kind.options.map((o) => o.label));
  });

  /*
    A value the catalog does not list still has to be shown: the file may hold a key a newer component
    understands, and a select that silently reset it to its first option would write that reset on the next
    save.
  */
  test("keeps a value the catalog does not list, rather than dropping to the first option", () => {
    store.set(CHOICE, "99");
    const view = draw(CHOICE);
    expect(view.one<HTMLSelectElement>("select").value).toBe("99");
  });

  test("shows an absent value as unset rather than as blank", () => {
    store.set(CHOICE, "");
    expect(draw(CHOICE).text()).toContain("(unset)");
  });
});

describe("a bounded integer", () => {
  test("carries the catalog's bounds onto the input, so the browser refuses out-of-range typing", () => {
    const view = draw(BOUNDED_INT);
    const input = view.one<HTMLInputElement>("input[type=number]");
    expect(input.min).toBe("0");
    expect(input.max).toBe("13");
  });

  test("shows the catalog's unit beside the value", () => {
    expect(draw(BOUNDED_INT).text()).toContain("days");
  });

  test("drawn as a slider where the row asks for one, with the range the catalog states", () => {
    const view = draw(BOUNDED_INT, "slider");
    const slider = view.one<HTMLInputElement>("input[type=range]");
    expect([slider.min, slider.max, slider.step]).toEqual(["0", "13", "1"]);
  });
});

describe("a float slider", () => {
  test("writes back at the precision the game's files use, not at the slider's own", () => {
    const view = draw(FLOAT, "slider");
    const slider = view.one<HTMLInputElement>("input[type=range]");
    slider.value = slider.max;
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    // Six decimal places is what fallout2.cfg holds; a bare `String(1)` would rewrite the line's shape.
    expect(store.valueOf(FLOAT)).toMatch(/^\d+\.\d{6}$/);
  });
});

describe("a scale setting", () => {
  /*
    The file stores 0..max - master_volume runs to 32767 - and a user has nothing to do with that number, so the
    control speaks percent in both directions. This is the pair that has to agree: what the readout shows and
    what a move writes.
  */
  test("reads the engine's own scale as a percentage", () => {
    const kind = def(SCALE).kind;
    if (kind.type !== "scale") throw new Error("the fixture setting stopped being a scale");
    store.set(SCALE, String(kind.max));
    expect(draw(SCALE).text()).toContain("100%");
  });

  test("writes a percentage back on the engine's scale", () => {
    const kind = def(SCALE).kind;
    if (kind.type !== "scale") throw new Error("the fixture setting stopped being a scale");
    const view = draw(SCALE);
    const slider = view.one<HTMLInputElement>("input[type=range]");
    slider.value = "50";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(Number(store.valueOf(SCALE))).toBeCloseTo(kind.max / 2, -1);
  });
});

describe("a key setting", () => {
  /*
    On `code` rather than `key`: the file stores a physical scancode, so a keyboard laid out differently must
    still write the scancode the game will see.
  */
  test("captures a physical key as its scancode", () => {
    const view = draw(KEY);
    const input = view.one<HTMLInputElement>("input.keycap");
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyR", bubbles: true, cancelable: true }));
    expect(store.valueOf(KEY)).toMatch(/^\d+$/);
  });

  test("ignores a keypress that names no scancode, leaving the value alone", () => {
    store.set(KEY, "19");
    const view = draw(KEY);
    const input = view.one<HTMLInputElement>("input.keycap");
    input.dispatchEvent(new KeyboardEvent("keydown", { code: "MediaPlayPause", bubbles: true, cancelable: true }));
    expect(store.valueOf(KEY)).toBe("19");
  });

  test("is read-only, so the field cannot be typed into past the capture", () => {
    expect(draw(KEY).one<HTMLInputElement>("input.keycap").readOnly).toBe(true);
  });
});

describe("a text setting", () => {
  test("writes what was typed", () => {
    const view = draw(TEXT);
    const input = view.one<HTMLInputElement>("input.text");
    input.value = "master.dat";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(store.valueOf(TEXT)).toBe("master.dat");
  });

  test("says the game supplies a default rather than showing an empty box with no explanation", () => {
    store.set(TEXT, "");
    expect(draw(TEXT).one<HTMLInputElement>("input.text").placeholder).toBe("default");
  });
});

describe("every control", () => {
  /*
    The label is the only thing naming the row for a screen reader - the visible label lives in `SettingRow`,
    outside this component - so a kind that drew a bare input would be an unnamed control. Driven across every
    kind at once rather than per case, because the branch that forgets it is the one nobody wrote a case for.
  */
  test("carries an accessible name in every kind the catalog defines", () => {
    for (const [id, control] of [
      [BOOL, undefined],
      [CHOICE, undefined],
      [CHOICE, "radio"],
      [BOUNDED_INT, undefined],
      [BOUNDED_INT, "slider"],
      [SCALE, undefined],
      [KEY, undefined],
      [TEXT, undefined],
    ] as const) {
      const view = draw(id, control);
      const named = view.all("[aria-label]");
      expect(named.length, `${id} as ${control ?? "its default control"}`).toBeGreaterThan(0);
      expect(named[0]!.getAttribute("aria-label")).toContain(def(id).label);
      unmountAll();
    }
  });
});
