/**
 * Turns the extracted previous-implementation layout into a typed module the interface renders directly.
 *
 * Kept separate from the catalog generator: the catalog says what a setting IS, this says where it was shown.
 * A setting can lose its place in the layout without ceasing to exist, and the reverse would be a defect.
 */
import fs from "node:fs";
import { idFor } from "./ids.mjs";

/*
  Hidden beyond what the previous interface hid. `free_space` is read, stored and written back by fallout2-ce
  and never consumed, so the control offered a choice that changes nothing. The setting stays in the catalog -
  the key is real and has to round-trip - it simply has no row.
*/
const ALSO_HIDDEN = new Set(["fallout2.cfg|system|free_space"]);

const layout = JSON.parse(fs.readFileSync("scripts/gen/py-layout.json", "utf8"));
const catalog = fs.readFileSync("packages/games-fallout2/src/catalog.ts", "utf8");
const known = new Set([...catalog.matchAll(/\{id: "([^"]+)"/g)].map((m) => m[1]));

let settings = 0;
const missing = [];

function node(item, file) {
  if (item.kind === "frame") {
    return { kind: "frame", title: item.title, items: item.items.map((i) => node(i, file)) };
  }
  if (item.kind === "widget") return { kind: "widget", id: item.id };
  const id = idFor(file, item.section, item.key);
  if (!known.has(id)) missing.push(`${file} [${item.section}] ${item.key} -> ${id}`);
  settings++;
  // The control the previous interface used. The catalog's kind does not imply it: a bounded float was a
  // slider there and would otherwise become a number box here.
  const control = item.kind === "raw" ? "spin" : item.kind;
  const hidden = item.hidden || ALSO_HIDDEN.has(`${file}|${item.section}|${item.key}`);
  return { kind: "setting", id, control, ...(hidden ? { hidden: true } : {}) };
}

const files = layout.map((f) => ({
  file: f.file,
  label: f.label,
  tabs: f.tabs.map((t) => ({ title: t.title, items: t.items.map((i) => node(i, f.file)) })),
}));

// A control the layout places but the catalog does not describe would render as a blank row, so fail here.
if (missing.length) {
  console.error(`${missing.length} layout entries have no catalog setting:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}

const out = `// Generated from the previous implementation's layout modules by scripts/gen/gen-layout.mjs. Do not edit by hand.
//
// The tab, frame and control order the previous interface presented, so a user coming from it finds every
// setting where they left it. What each setting IS lives in the catalog; this only says where it was shown.

/** The control the previous interface drew, which its catalog kind alone does not determine. */
export type Control = "checkbox" | "slider" | "spin" | "dropdown" | "qinput" | "radio";

/** A control, a titled group of them, or one of the few widgets that is not a single setting. */
export type LayoutNode =
  | { kind: "setting"; id: string; control: Control; hidden?: boolean }
  | { kind: "frame"; title: string; items: readonly LayoutNode[] }
  | { kind: "widget"; id: string };

export interface LayoutTab {
  title: string;
  items: readonly LayoutNode[];
}

export interface LayoutFile {
  /** The config file this tab edits. */
  file: string;
  /** What the previous interface called it - the component, not the filename. */
  label: string;
  tabs: readonly LayoutTab[];
}

export const LAYOUT: readonly LayoutFile[] = ${JSON.stringify(files, null, 1)};
`;

fs.writeFileSync("packages/games-fallout2/src/layout.ts", out);
console.log(`${files.length} files, ${files.reduce((n, f) => n + f.tabs.length, 0)} tabs, ${settings} placed settings`);
for (const f of files) {
  console.log(`  ${f.label.padEnd(6)} ${f.tabs.map((t) => t.title).join(" | ")}`);
}
