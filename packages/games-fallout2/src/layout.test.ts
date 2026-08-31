import { describe, expect, it } from "vitest";
import { SETTINGS } from "./catalog.js";
import { LAYOUT, type LayoutNode } from "./layout.js";

function flatten(items: readonly LayoutNode[]): LayoutNode[] {
  return items.flatMap((n) => (n.kind === "frame" ? flatten(n.items) : [n]));
}

const placed = LAYOUT.flatMap((f) => f.tabs.flatMap((t) => flatten(t.items)));
const settingIds = placed.filter((n) => n.kind === "setting").map((n) => n.id);

/** Which tab of which group each setting has a row on, keyed by group. */
const rows = new Map<string, Map<string, string>>();
for (const group of LAYOUT) {
  const here = new Map<string, string>();
  for (const t of group.tabs) for (const n of flatten(t.items)) if (n.kind === "setting") here.set(n.id, t.title);
  rows.set(group.id, here);
}

/** The group that shows a given address: the engine's, or the one named for the file it sits in. */
const groupFor = (at: { file: string; engine?: string }): string => at.engine ?? at.file;

describe("layout", () => {
  it("keeps the previous interface's three groups in its order, and adds one per engine after them", () => {
    expect(LAYOUT.map((f) => f.label)).toEqual(["Game", "HiRes", "Sfall", "CE", "Fission"]);
    expect(LAYOUT.map((f) => f.id)).toEqual(["fallout2.cfg", "f2_res.ini", "ddraw.ini", "fallout2-ce", "fission"]);
    // A group is a file's or an engine's, never both and never neither: the id means one thing or the other.
    expect(LAYOUT.map((f) => f.engine)).toEqual([undefined, undefined, undefined, "fallout2-ce", "fission"]);
    for (const f of LAYOUT) if (f.engine !== undefined) expect(f.engine).toBe(f.id);
  });

  it("gives every address of every setting a row in the group that shows it, and never two on one tab", () => {
    // A target with no row is a live value the user cannot reach: whichever component is installed, the tab
    // for it has to offer the setting. A linked setting therefore has a row in each group that reads it -
    // but never twice on the same tab, which would be one setting editing itself from two rows.
    for (const group of LAYOUT) {
      const ids = group.tabs.flatMap((t) => flatten(t.items)).flatMap((n) => (n.kind === "setting" ? [n.id] : []));
      expect(new Set(ids).size, `a setting is placed twice on ${group.label}`).toBe(ids.length);
    }
    const unreachable = SETTINGS.flatMap((s) =>
      s.targets.filter((t) => !rows.get(groupFor(t))?.has(s.id)).map((t) => `${s.id} -> ${t.file} [${t.section}]`),
    );
    expect(unreachable, "addresses with no row anywhere").toEqual([]);
  });

  it("places a linked setting on each side's own group rather than one of them", () => {
    // The point of the two-target shape: this is what would silently regress to a single row if a generator
    // change started placing a setting by its own address alone.
    const shared = SETTINGS.filter((s) => s.targets.length > 1);
    expect(shared.length, "no setting is linked, so this proves nothing").toBeGreaterThan(0);
    for (const s of shared) {
      const groups = new Set(s.targets.map((t) => groupFor(t)));
      expect(groups.size, `${s.id} links two addresses in one group`).toBeGreaterThan(1);
      for (const group of groups) expect(rows.get(group)?.has(s.id), `${s.id} has no row on ${group}`).toBe(true);
    }
  });

  it("places nothing the catalog does not describe", () => {
    const known = new Set(SETTINGS.map((s) => s.id));
    expect(settingIds.filter((id) => !known.has(id))).toEqual([]);
  });

  it("puts every setting under a group that actually writes it", () => {
    // A setting shown on the Sfall tab but written to fallout2.cfg would save somewhere the user is not
    // looking; one on an engine's tab that the engine does not read would do nothing at all.
    const byId = new Map(SETTINGS.map((s) => [s.id, s]));
    for (const group of LAYOUT) {
      for (const t of group.tabs) {
        for (const n of flatten(t.items)) {
          if (n.kind !== "setting") continue;
          const where = byId.get(n.id)?.targets.map((target) => groupFor(target)) ?? [];
          expect(where, `${n.id} on the ${group.label} tab`).toContain(group.id);
        }
      }
    }
  });

  it("shows a gated setting on the same tab as the control that opens its gate", () => {
    // Otherwise the setting sits greyed out with the reason on a screen the user cannot see from here. Per
    // target, since a gate rides on one address: Fission's strict-vanilla switch greys its own half of a
    // linked setting and says nothing about the sfall half on another tab.
    for (const s of SETTINGS) {
      for (const target of s.targets) {
        const gate = target.gatedBy;
        if (!gate) continue;
        const here = rows.get(groupFor(target));
        expect(here?.get(gate.id), `${s.id} is gated from another tab of ${groupFor(target)}`).toBe(here?.get(s.id));
      }
    }
  });

  it("records the control the previous interface drew for every setting", () => {
    // The catalog kind does not determine it: a bounded float was a slider there, a short choice a radio group,
    // and reading either off the kind alone turns both into a plain box.
    const kinds = new Set(["checkbox", "slider", "spin", "dropdown", "qinput", "radio"]);
    for (const n of placed) {
      if (n.kind !== "setting") continue;
      expect(kinds.has(n.control), `${n.id} has control "${n.control}"`).toBe(true);
    }
  });

  it("keeps the nine sliders as sliders", () => {
    const sliders = placed.flatMap((n) => (n.kind === "setting" && n.control === "slider" ? [n.id] : []));
    expect(sliders).toContain("game.preferences.brightness");
    expect(sliders).toContain("game.preferences.mouse_sensitivity");
    expect(sliders).toContain("game.sound.master_volume");
    expect(sliders.length).toBe(9);
  });

  it("has no two labels alike inside one frame", () => {
    // The frame states the noun and the tab states the component, so a label carries neither - which makes the
    // frame the scope in which one still has to be unique. Two files may both have a "Mode"; search tells them
    // apart by address, and nothing else ever shows them side by side.
    const byId = new Map(SETTINGS.map((s) => [s.id, s]));
    const clashes: string[] = [];
    const check = (items: readonly LayoutNode[], where: string) => {
      const seen = new Map<string, string>();
      for (const n of items) {
        if (n.kind === "frame") check(n.items, `${where} / ${n.title}`);
        if (n.kind !== "setting") continue;
        const label = byId.get(n.id)?.label.toLowerCase();
        if (label === undefined) continue;
        if (seen.has(label)) clashes.push(`${where}: "${label}" (${seen.get(label)} and ${n.id})`);
        else seen.set(label, n.id);
      }
    };
    for (const f of LAYOUT) for (const t of f.tabs) check(t.items, `${f.label} / ${t.title}`);
    expect(clashes).toEqual([]);
  });

  it("gives every slider a range to draw", () => {
    // The catalog test asserts only sliders carry a ceiling; this asserts it from the other side, so removing
    // one from the layout cannot quietly leave a range with nothing to draw it.
    const byId = new Map(SETTINGS.map((s) => [s.id, s]));
    for (const n of placed) {
      if (n.kind !== "setting" || n.control !== "slider") continue;
      const kind = byId.get(n.id)?.kind;
      if (kind?.type === "scale") continue; // its own max is the engine's raw range
      expect(kind?.type === "int" || kind?.type === "float", `${n.id} is a slider over a ${kind?.type}`).toBe(true);
      if (kind?.type !== "int" && kind?.type !== "float") continue;
      // By value, not just presence: a slider with the wrong ceiling passes an existence check, which is how
      // an upstream splash range of 5 survived one. These are fallout2-ce's own preference-table bounds.
      const RANGES: Record<string, [number, number]> = {
        "game.preferences.combat_speed": [0, 50],
        "game.preferences.text_base_delay": [1, 6],
        "game.preferences.text_line_delay": [0, 2],
        "game.preferences.brightness": [1, 1.17999267578125],
        "game.preferences.mouse_sensitivity": [1, 2.5],
      };
      const want = RANGES[n.id];
      expect(want, `${n.id} is a slider with no recorded range`).toBeDefined();
      expect([kind.min, kind.max], `${n.id} range`).toEqual(want);
    }
  });

  it("hides the settings whose value goes nowhere", () => {
    // Still placed and still in the catalog, so the key round-trips - just not offered as a choice. Asserted
    // by name: a check that merely counted hidden settings would pass on the wrong three.
    const hidden = placed.flatMap((n) => (n.kind === "setting" && n.hidden ? [n.id] : []));
    expect(hidden.toSorted()).toEqual([
      "game.preferences.text_line_delay", // the previous interface hid it
      "game.system.free_space", // fallout2-ce reads it and never uses it
      "hires.MAIN.UAC_AWARE", // the previous interface hid it; ZAX pins the value
    ]);
  });

  it("gives every tab and frame a title", () => {
    for (const group of LAYOUT) {
      expect(group.tabs.length, `${group.label} has no tabs`).toBeGreaterThan(0);
      for (const t of group.tabs) expect(t.title.length).toBeGreaterThan(0);
    }
    const titles = (items: readonly LayoutNode[]): string[] =>
      items.flatMap((n) => (n.kind === "frame" ? [n.title, ...titles(n.items)] : []));
    for (const group of LAYOUT) {
      for (const t of group.tabs) for (const title of titles(t.items)) expect(title.length).toBeGreaterThan(0);
    }
  });
});
