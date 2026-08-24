import { describe, expect, it } from "vitest";
import { isApplied, pendingTargets, validate } from "@zax/core";
import { ACTIONS, COMMON_RESOLUTIONS } from "./actions.js";
import { SETTINGS } from "./catalog.js";

const byId = new Map(SETTINGS.map((s) => [s.id, s]));

describe("actions reference real settings", () => {
  it("targets only setting ids that exist", () => {
    // A typo here is invisible at runtime: the action would write an override nothing reads and report itself
    // as never applied. Nothing else in the suite would catch it.
    for (const action of ACTIONS) {
      for (const id of Object.keys(action.targets)) {
        expect(byId.has(id), `${action.id} targets unknown setting ${id}`).toBe(true);
      }
    }
  });

  it("writes values each target setting actually accepts", () => {
    for (const action of ACTIONS) {
      for (const [id, value] of Object.entries(action.targets)) {
        const def = byId.get(id)!;
        const result = validate(def, value);
        expect(result.ok, `${action.id} writes ${value} to ${id}: ${result.ok ? "" : result.reason}`).toBe(true);
        if (def.kind.type === "bool") {
          expect([def.kind.onValue, def.kind.offValue], `${action.id} -> ${id}`).toContain(value);
        }
        if (def.kind.type === "choice") {
          expect(
            def.kind.options.map((o) => o.value),
            `${action.id} -> ${id}`,
          ).toContain(value);
        }
      }
    }
  });

  it("collapses more than one setting", () => {
    // A one-key action duplicates the control the settings list already renders, and pins it to a single value
    // while hiding the others - "skip the intro movies" was a button over a three-way dropdown.
    for (const a of ACTIONS) {
      expect(Object.keys(a.targets).length, `${a.id} writes only one setting`).toBeGreaterThan(1);
    }
  });

  it("has unique ids and non-empty wording", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ACTIONS) {
      expect(a.label.trim()).not.toBe("");
      expect(a.description.trim()).not.toBe("");
      expect(a.appliedLabel.trim()).not.toBe("");
    }
  });

  it("pairs each enable action with a way back", () => {
    // An action that cannot be undone strands the user in a state they cannot leave from the same screen.
    const enable = ACTIONS.find((a) => a.id === "debug.enable")!;
    const disable = ACTIONS.find((a) => a.id === "debug.disable")!;
    expect(Object.keys(enable.targets).sort()).toEqual(Object.keys(disable.targets).sort());
  });

  it("takes WINEDEBUG the opposite way in each direction", () => {
    // Turning every sfall log on leaves Wine silenced unless this half runs, and a report gathered that way is
    // missing the part that explains a crash happening before the game starts.
    expect(ACTIONS.find((a) => a.id === "debug.enable")?.wine).toEqual({ debug: "" });
    expect(ACTIONS.find((a) => a.id === "debug.disable")?.wine).toEqual({ debug: "-all" });
  });
});

describe("applied detection", () => {
  const action = ACTIONS.find((a) => a.id === "fix.not-responding")!;

  it("reports applied only when every target matches", () => {
    const all = (id: string) => action.targets[id];
    expect(isApplied(action, all)).toBe(true);

    const ids = Object.keys(action.targets);
    const allButOne = (id: string) => (id === ids[0] ? "0" : action.targets[id]);
    expect(isApplied(action, allButOne)).toBe(false);
  });

  it("lists only the targets that still differ", () => {
    const ids = Object.keys(action.targets);
    const pending = pendingTargets(action, (id) => (id === ids[0] ? "0" : action.targets[id]));
    expect(pending.map((p) => p.id)).toEqual([ids[0]]);
    expect(pending[0]?.from).toBe("0");
  });

  it("treats an unset value as not applied", () => {
    expect(isApplied(action, () => undefined)).toBe(false);
  });
});

describe("the Wine half of an action", () => {
  const action = ACTIONS.find((a) => a.id === "debug.enable")!;
  const matching = (id: string) => action.targets[id];

  it("holds the action back while WINEDEBUG still differs", () => {
    expect(isApplied(action, matching, "-all")).toBe(false);
    expect(isApplied(action, matching, "")).toBe(true);
  });

  it("counts as one more change the action will make", () => {
    const pending = pendingTargets(action, matching, "-all");
    expect(pending.map((p) => p.id)).toEqual(["WINEDEBUG"]);
    expect(pending[0]?.from).toBe("-all");
  });

  it("is left out entirely on a machine with no Wine", () => {
    // Otherwise every Windows install would show the action as unapplied over a field that is not on screen.
    expect(isApplied(action, matching, null)).toBe(true);
    expect(pendingTargets(action, matching, null)).toEqual([]);
  });
});

describe("curated surface", () => {
  it("offers only resolutions the preset targets actually accept", () => {
    // The same two ids the presets dropdown writes; validated here because the dropdown itself never checks.
    const w = byId.get("hires.MAIN.SCR_WIDTH");
    const h = byId.get("hires.MAIN.SCR_HEIGHT");
    expect(w).toBeDefined();
    expect(h).toBeDefined();
    // One control writes both keys at once, so they have to belong to the same file.
    expect(w!.file).toBe(h!.file);
    for (const r of COMMON_RESOLUTIONS) {
      expect(validate(w!, String(r.width)).ok, `width ${r.width}`).toBe(true);
      expect(validate(h!, String(r.height)).ok, `height ${r.height}`).toBe(true);
    }
  });
});
