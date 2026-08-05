import { LAYOUT, type LayoutNode } from "./layout.js";

/**
 * Where a setting sits in the interface. Search lifts a row out of the tab that would otherwise locate it, so
 * the result has to carry its own address or the user cannot tell two similarly-named settings apart.
 */
export interface Place {
  file: string;
  /** The settings tab, by the component's name rather than the filename. */
  label: string;
  tab: string;
  /** Enclosing frame titles, outermost first. Empty when the setting sits directly on the tab. */
  frames: readonly string[];
}

/** Derived from the layout rather than stored on the setting: where it is shown is the layout's business. */
export function placesById(): ReadonlyMap<string, Place> {
  const out = new Map<string, Place>();
  const walk = (items: readonly LayoutNode[], base: Omit<Place, "frames">, frames: readonly string[]) => {
    for (const n of items) {
      if (n.kind === "frame") walk(n.items, base, [...frames, n.title]);
      else if (n.kind === "setting") out.set(n.id, { ...base, frames });
    }
  };
  for (const f of LAYOUT) {
    for (const t of f.tabs) walk(t.items, { file: f.file, label: f.label, tab: t.title }, []);
  }
  return out;
}

/**
 * Settings the layout places but does not draw. Search applies the same rule the tab does - offering a result
 * that its own tab will not show is a dead end, and the "go to" on it lands nowhere.
 */
export function hiddenIds(): ReadonlySet<string> {
  const out = new Set<string>();
  const walk = (items: readonly LayoutNode[]) => {
    for (const n of items) {
      if (n.kind === "frame") walk(n.items);
      else if (n.kind === "setting" && n.hidden) out.add(n.id);
    }
  };
  for (const f of LAYOUT) for (const t of f.tabs) walk(t.items);
  return out;
}

/** "Sfall / Main / Graphics", for a one-line address under a search result. */
export function describePlace(place: Place): string {
  return [place.label, place.tab, ...place.frames].join(" / ");
}
