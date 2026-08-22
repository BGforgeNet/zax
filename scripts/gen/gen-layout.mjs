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

/*
  Where a setting from added.yml joins the layout. The extracted trees cannot know about a setting the
  previous implementation never had, and `layout.test.ts` holds every catalog setting to exactly one place -
  so an addition without a row here fails the suite rather than rendering nowhere.

  `tab` is the tab's title on that file's own tab strip, `frame` the group inside it, created at the end of
  the tab where it does not exist yet. Position inside a frame is `after` a named setting, `first`, or - with
  neither - the end. `control` is a judgement this file makes, the way the extraction made it for the rest:
  the catalog's kind does not imply it.
*/
const ADDED = [
  // The master switch for the four it already holds, so it reads before them rather than after.
  { id: "game.debug.mode", file: "fallout2.cfg", tab: "Debug", frame: "Main", first: true, control: "dropdown" },

  { id: "sfall.Sound.NumSoundBuffers", file: "ddraw.ini", tab: "Main", frame: "Sound", control: "spin" },
  { id: "sfall.Sound.AllowSoundForFloats", file: "ddraw.ini", tab: "Main", frame: "Sound", control: "checkbox" },
  { id: "sfall.Sound.AllowDShowSound", file: "ddraw.ini", tab: "Main", frame: "Sound", control: "checkbox" },

  // Two file paths from different ini sections, which the frames do not track - Combat already holds Misc keys.
  { id: "sfall.Main.TranslationsINI", file: "ddraw.ini", tab: "Main", frame: "Paths", control: "qinput" },
  { id: "sfall.Scripts.IniConfigFolder", file: "ddraw.ini", tab: "Main", frame: "Paths", control: "qinput" },

  {
    id: "sfall.Misc.PartyMemberNonRandomLevelUp",
    file: "ddraw.ini",
    tab: "Main",
    frame: "Misc",
    after: "sfall.Misc.NPCAutoLevel",
    control: "checkbox",
  },
  { id: "sfall.Misc.EnableHeroAppearanceMod", file: "ddraw.ini", tab: "Main", frame: "Misc", control: "dropdown" },

  {
    id: "sfall.Misc.SpeedInventoryPCRotation",
    file: "ddraw.ini",
    tab: "Interface",
    frame: "Inventory",
    control: "spin",
  },
  { id: "sfall.Misc.ItemCounterAutoCaps", file: "ddraw.ini", tab: "Interface", frame: "Barter", control: "checkbox" },

  {
    id: "sfall.Debugging.AllowUnsafeScripting",
    file: "ddraw.ini",
    tab: "Debug",
    after: "sfall.Debugging.DebugMode",
    control: "dropdown",
  },
];

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

for (const add of ADDED) {
  if (!known.has(add.id)) throw new Error(`ADDED: ${add.id} is not a catalog setting`);
  const file = files.find((f) => f.file === add.file);
  const tab = file?.tabs.find((t) => t.title === add.tab);
  if (!tab) throw new Error(`ADDED: ${add.id} names no tab "${add.file} / ${add.tab}"`);

  let into = tab.items;
  if (add.frame) {
    let frame = tab.items.find((i) => i.kind === "frame" && i.title === add.frame);
    if (!frame) {
      frame = { kind: "frame", title: add.frame, items: [] };
      tab.items.push(frame);
    }
    into = frame.items;
  }

  const node = { kind: "setting", id: add.id, control: add.control };
  if (add.first) into.unshift(node);
  else if (add.after === undefined) into.push(node);
  else {
    const at = into.findIndex((i) => i.kind === "setting" && i.id === add.after);
    if (at === -1) throw new Error(`ADDED: ${add.id} follows ${add.after}, which is not in that frame`);
    into.splice(at + 1, 0, node);
  }
  settings++;
}

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
