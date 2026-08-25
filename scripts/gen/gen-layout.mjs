/**
 * Turns the extracted previous-implementation layout into a typed module the interface renders directly.
 *
 * Kept separate from the catalog generator: the catalog says what a setting IS, this says where it was shown.
 * A setting can lose its place in the layout without ceasing to exist, and the reverse would be a defect.
 */
import fs from "node:fs";
import { idFor } from "./ids.mjs";
import { SETTING_DEFS } from "./gen-catalog.mjs";
import { ENGINE_TABS } from "./engine-settings.mjs";

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
  // The window's size before what is shown inside it.
  {
    id: "sfall.Interface.ExpandBarter",
    file: "ddraw.ini",
    tab: "Interface",
    frame: "Barter",
    first: true,
    control: "checkbox",
  },

  {
    id: "sfall.Misc.RemoveCriticalTimelimits",
    file: "ddraw.ini",
    tab: "Main",
    frame: "Combat",
    control: "checkbox",
  },

  {
    id: "sfall.Debugging.AllowUnsafeScripting",
    file: "ddraw.ini",
    tab: "Debug",
    after: "sfall.Debugging.DebugMode",
    control: "dropdown",
  },
];

const layout = JSON.parse(fs.readFileSync("scripts/gen/py-layout.json", "utf8"));
// The catalog generator's own settings, not the module it writes: which addresses a setting holds is its
// answer, and a second derivation of it here could disagree with the catalog these rows are placed against.
const known = new Set(SETTING_DEFS.map((d) => d.id));

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
  id: f.file,
  label: f.label,
  tabs: f.tabs.map((t) => ({ title: t.title, items: t.items.map((i) => node(i, f.file)) })),
}));

for (const add of ADDED) {
  if (!known.has(add.id)) throw new Error(`ADDED: ${add.id} is not a catalog setting`);
  const file = files.find((f) => f.id === add.file);
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

/*
  One group per engine, beside the game's own three. A setting appears on an engine's tab when it has an
  address that engine reads - its own keys and every linked setting alike, since a link that showed on only
  one tab would leave a live setting unreachable behind whichever tab happened to be chosen. A linked setting
  therefore has a row in two places, which is why the layout's one-place-per-setting rule holds over the
  game's own three groups rather than over all of them.

  Grouped by the section that address sits in, which is the engine's own arrangement of its settings and the
  only one either project states.
*/
/*
  What already sets each setting apart on the game's own tabs: the frame it sits in, or failing that the tab.
  An engine tab reuses it, because a section is a flat list of keys and a label only has to be unique where
  the user can see two at once - two of the game's preferences are both labelled "difficulty", told apart
  there by sitting under Preferences and under Combat. Side by side in one engine section, neither row says
  which. Reusing the heading rather than inventing one keeps the arrangement a user has already learnt.
*/
const frameOf = new Map();
const noteFrames = (items, heading) => {
  for (const item of items) {
    if (item.kind === "frame") noteFrames(item.items, item.title);
    else if (item.kind === "setting") frameOf.set(item.id, heading);
  }
};
for (const group of files) for (const tab of group.tabs) noteFrames(tab.items, tab.title);

let engineRows = 0;
for (const [engine, { label, sections }] of Object.entries(ENGINE_TABS)) {
  const named = new Set(Object.keys(sections));
  for (const setting of SETTING_DEFS) {
    for (const at of setting.targets) {
      if (at.engine === engine && !named.has(`${at.file}|${at.section}`)) {
        throw new Error(`${engine}: nothing says what to call the "${at.file} [${at.section}]" tab`);
      }
    }
  }

  const tabs = [];
  for (const [address, title] of Object.entries(sections)) {
    const [file, section] = address.split("|");
    // The engine's own keys first, ungrouped - they are what the tab exists for - then the settings it
    // shares with another component, under the frames those already have.
    const items = [];
    const framed = new Map();
    for (const setting of SETTING_DEFS) {
      const at = setting.targets.find((one) => one.engine === engine && one.file === file && one.section === section);
      if (at === undefined) continue;
      // A checkbox for a switch, a dropdown for an enumeration, a box for the rest. Neither project publishes
      // an interface of its own for these, so there is no earlier arrangement to follow as there was for the
      // game's own three groups.
      const control =
        setting.kind.type === "bool"
          ? "checkbox"
          : setting.kind.type === "choice"
            ? "dropdown"
            : setting.kind.type === "text"
              ? "qinput"
              : "spin";
      const node = { kind: "setting", id: setting.id, control };
      // A frame repeating the tab's own title says nothing the tab has not; those rows stay at the top level.
      const frame = frameOf.get(setting.id) === title ? undefined : frameOf.get(setting.id);
      if (frame === undefined) items.push(node);
      else {
        if (!framed.has(frame)) framed.set(frame, { kind: "frame", title: frame, items: [] });
        framed.get(frame).items.push(node);
      }
      engineRows++;
    }
    items.push(...framed.values());
    if (items.length > 0) tabs.push({ title, items });
  }
  if (tabs.length === 0) throw new Error(`${engine}: no setting reaches it, so its group would be empty`);
  files.push({ id: engine, label, engine, tabs });
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
  /**
   * What identifies this group of tabs and keys which of them is open: the config file's name for the game's
   * own three, the engine's id for an engine's. An engine's tabs are not one file's - fallout2-ce shows both
   * the keys it reads from the game's config and the ones a linked setting puts in the content patch.
   */
  id: string;
  /** What the previous interface called it - the component, not the filename. */
  label: string;
  /** The engine whose settings these tabs show, absent for the game's own three. */
  engine?: string;
  tabs: readonly LayoutTab[];
}

export const LAYOUT: readonly LayoutFile[] = ${JSON.stringify(files, null, 1)};
`;

fs.writeFileSync("packages/games-fallout2/src/layout.ts", out);
console.log(
  `${files.length} groups, ${files.reduce((n, f) => n + f.tabs.length, 0)} tabs, ` +
    `${settings} placed settings and ${engineRows} engine rows over them`,
);
for (const f of files) {
  console.log(`  ${f.label.padEnd(6)} ${f.tabs.map((t) => t.title).join(" | ")}`);
}
