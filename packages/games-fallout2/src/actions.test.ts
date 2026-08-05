import { describe, expect, it } from "vitest";
import { isApplied, pendingTargets, validate } from "@zax/core";
import { ACTIONS, COMMON_RESOLUTIONS, RESOLUTION_PAIRS } from "./actions.js";
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
          expect(def.kind.options.map((o) => o.value), `${action.id} -> ${id}`).toContain(value);
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

describe("curated surface", () => {
  it("points every resolution pair at real settings in one file", () => {
    for (const pair of RESOLUTION_PAIRS) {
      const w = byId.get(pair.width);
      const h = byId.get(pair.height);
      expect(w, `${pair.id} width`).toBeDefined();
      expect(h, `${pair.id} height`).toBeDefined();
      // A merged control writes both keys at once, so they have to belong to the same file.
      expect(w!.file, `${pair.id} spans files`).toBe(h!.file);
    }
  });

  it("offers only resolutions each pair actually accepts", () => {
    for (const pair of RESOLUTION_PAIRS) {
      const w = byId.get(pair.width)!;
      const h = byId.get(pair.height)!;
      for (const r of COMMON_RESOLUTIONS) {
        expect(validate(w, String(r.width)).ok, `${pair.id} width ${r.width}`).toBe(true);
        expect(validate(h, String(r.height)).ok, `${pair.id} height ${r.height}`).toBe(true);
      }
      if (pair.nativeValue !== undefined) {
        expect(validate(w, pair.nativeValue).ok, `${pair.id} native width`).toBe(true);
        expect(validate(h, pair.nativeValue).ok, `${pair.id} native height`).toBe(true);
      }
    }
  });

  it("does not list one setting under two pairs", () => {
    const ids = RESOLUTION_PAIRS.flatMap((p) => [p.width, p.height]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

