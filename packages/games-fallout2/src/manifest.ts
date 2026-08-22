/**
 * `f2mod.yml`: the manifest a mod's release carries and this application interprets. It reaches ZAX two ways
 * - published as a release asset beside the payload, or read from the repository at the release's tag - so
 * `version` and `archive` may be absent from the file and supplied by the release instead.
 *
 * Parsing is strict and every refusal names its cause. A manifest is downloaded data even from a trusted
 * publisher, so it gets a boundary of its own: a size cap before parsing, a YAML alias cap, length-capped
 * plain-text strings, and confinement for every path-shaped field. An unknown field refuses rather than
 * passes, so a misspelling cannot silently drop a safety check; the one place leniency lives is the `extra`
 * block, ignored by contract. Anything the format defines that this version does not implement - a base
 * mod's install procedure, a later spec - refuses as "needs a newer ZAX" rather than half-installing.
 */

import { parse } from "yaml";
import { GAME_TYPES, type GameType, type SettingDef, type SettingKind, type ValueTest } from "@zax/core";
import { SETTINGS } from "./catalog.js";
import { grantsFor } from "./mod-grants.js";

/**
 * The file's name wherever it sits - repository root, archive root, release asset - the same on purpose. The
 * name is not manager-branded: the manifest declares its own `game`, and a second manager reading this format
 * should not have to ship a file named after this application.
 */
export const MANIFEST_NAME = "f2mod.yml";

/**
 * What the release supplies for fields the manifest may leave out. A committed manifest states neither its
 * version nor its payload's name - the tag and the release's assets do - and a manifest re-read from a record
 * or a journal takes back the version that was resolved when it was installed.
 */
export interface ManifestDefaults {
  version?: string;
  archive?: string;
}

/**
 * Refused before parsing. A catalog-parity settings schema with help text runs tens of kilobytes; something
 * past this is not a manifest, whatever it is.
 */
export const MANIFEST_BYTE_CAP = 256 * 1024;

/** Anchors and aliases past this refuse - an alias flood multiplies in memory, not on the wire. */
const ALIAS_CAP = 64;

/**
 * The highest manifest spec this version implements, and a floor rather than a pin: a manifest may state this
 * or anything below it. The format is append-only within a major - a field's meaning never changes and a
 * retired one stays parsed and ignored for a major - so an older spec still means here what it said when it
 * was written, and only a later one can name something this version cannot honour.
 */
export const MANIFEST_SPEC = 1;

const SHORT_TEXT = 200;
const LONG_TEXT = 1000;

/** A mod setting is a catalog definition plus the value the release ships, kept for revert and display. */
export interface ModSetting extends SettingDef {
  default?: string;
}

/**
 * A settings entry this version cannot draw, kept so the interface can say so rather than say nothing.
 *
 * The two classes of ignorance are not alike, and this is the second. A field that decides what lands on disk
 * refuses the manifest when unknown, because ignoring it writes the wrong thing. A settings entry only ever
 * edits a key in the mod's own ini, and the release ships its own default there - so a control this version
 * cannot render costs the user a knob and never costs correctness, and refusing the mod over one would make a
 * mod uninstallable for sitting on the wrong side of a ZAX release.
 */
export interface DroppedSetting {
  /** The address the manifest spelled, `section.key`. */
  address: string;
  why: string;
}

export interface RefuseRule {
  /** Fires when every `present` path exists and every `absent` path does not. At least one list is non-empty. */
  present: readonly string[];
  absent: readonly string[];
  reason: string;
}

/**
 * One choice inside a group. A part names its own release asset, because that is what every real case is -
 * four zips, four dats, two zips - and no part is ever a subset of another's archive, so nothing here slices
 * an archive up.
 */
export interface ModPart {
  /** Permanent the way the mod's id is: the recorded selection names it, so a rename reads as a new part. */
  id: string;
  label: string;
  help?: string;
  /** The release asset this part deploys - its own download, its own digest, its own preflight. */
  archive: string;
  /** What this part puts in the mods folder, read exactly as the mod's own `entries` are. */
  entries?: readonly string[];
  /** Another part this one is meaningless without - Cassidy's voices without its head. */
  needs?: string;
}

export interface ModPartGroup {
  label: string;
  /** `one` picks at most one - a group may end with nothing chosen - and `any` is each option on or off. */
  pick: "one" | "any";
  options: readonly ModPart[];
}

/**
 * What installing this mod does to the install. Pluggable stacks and comes off again, permanent stacks and
 * never does, base transforms the game into another one - which is why only a base mod names an installer.
 */
export type ModType = "pluggable" | "permanent" | "base";

/**
 * One choice inside the installer's own component list. Not a part: a part names a release asset and this
 * names a string passed to one installer, so the two are different fields whatever their shape has in common.
 */
export interface ModComponent {
  /** The installer's own name for it, verbatim - `walk_speed\low_fps` as the Inno script spells it. */
  id: string;
  label: string;
  help?: string;
  /** Selected whatever the user picks. Inno's `/COMPONENTS` deselects everything it does not name. */
  required?: boolean;
}

export interface ModComponentGroup {
  label: string;
  pick: "one" | "any";
  options: readonly ModComponent[];
}

/**
 * How a base mod installs, per platform. Both routes exist because upstream publishes both, and they are not
 * the same install: the Windows one is an installer program that takes the game directory as an argument,
 * while the other is a payload extracted over the game with a script inside it that finishes the job.
 */
export interface ModInstaller {
  windows?: {
    asset: string;
    /** The convention ZAX invokes it by. `inno` is the only one this version knows. */
    silent: "inno";
    /** The choices that installer offers. Windows-only, because only the Inno route has them. */
    components?: readonly ModComponentGroup[];
  };
  other?: {
    asset: string;
    /** What to run once the payload is extracted, relative to the install - the script the payload ships. */
    run: string;
  };
}

/**
 * A mod that produces a new install inside this one rather than transforming it. The directory is one segment
 * because that is what the payload's own root is - Fallout et tu's zip holds nothing but `Fallout1in2/` - and
 * it becomes the confinement bound for everything the install writes, exactly as `mods/` is for a stacking mod.
 */
export interface ModCreates {
  directory: string;
}

/** A value ZAX must ask the user for, with the file that says the answer is the right one. */
export interface ModInput {
  id: string;
  label: string;
  help?: string;
  /** A file the chosen folder must hold - Fallout 1's `master.dat` for the archive Fo1in2 unpacks. */
  holds: string;
}

/**
 * Unpacking an archive the user owns into the created install. `list` and `into` are read inside the created
 * directory, so the response file that is used is the one the payload shipped and the extraction cannot aim
 * anywhere else.
 */
export interface ModExtractDat {
  /** The input whose `holds` file is unpacked. */
  from: string;
  /** The file naming what to lift out of it, one path per line. */
  list: string;
  into: string;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  type: ModType;
  /** Why the mod can never be uninstalled. Present exactly when the type is permanent. */
  reason?: string;
  /** The release asset carrying the payload, stamped by CI. An authored file has none; installing needs it. */
  archive?: string;
  /** Game types the mod installs on. Absent means any - the stacking default; a base mod's is vanilla alone. */
  installOn?: readonly GameType[];
  /** The game type the install reports afterwards. Base mods only, where it is required. */
  becomes?: GameType;
  /** How to install it, per platform. A base mod names this or `creates`, never both and never neither. */
  installer?: ModInstaller;
  /** The install this one creates beside the host, for a base mod ZAX performs rather than delegates. */
  creates?: ModCreates;
  /** What the user must be asked for before it can run. A creating mod's alone. */
  inputs?: readonly ModInput[];
  /** The archive out of one of those inputs that is unpacked into the created install. */
  extractDat?: ModExtractDat;
  /** The lowest sfall version the mod works with, answered by the updater rather than a refusal. */
  requiresSfall?: string;
  /** Files that belong to the user and survive upgrades by merging. Absent means every payload `.ini`. */
  state?: readonly string[];
  /**
   * What the mod puts in the mods folder, spelled as the loader names it - relative to `mods\`, so these
   * become its order lines verbatim. Absent means the payload decides, which is the top-level `mods/*.dat`
   * derivation every manifest written before this field relied on.
   *
   * Declared rather than derived because two things cannot be read off the payload's paths: a mod whose
   * entry is a folder (`InventoryFilter.dat` is a directory), and which of `mods/patches/extra.dat`'s two
   * readings - a folder entry `patches`, or a nested dat - the mod meant.
   */
  entries?: readonly string[];
  /**
   * The choices this release offers, groups in the order the manifest declares them. A manifest with parts
   * states no top-level `archive`: each part names the asset it deploys.
   */
  parts?: readonly ModPartGroup[];
  refuse: readonly RefuseRule[];
  settings: readonly ModSetting[];
  /** Entries the schema declares that this version cannot draw. The mod installs; these controls do not. */
  dropped: readonly DroppedSetting[];
}

const CATALOG_IDS = new Set(SETTINGS.map((setting) => setting.id));

/** The first piece of every catalog id - `game`, `hires`, `sfall` - each reserved whole for the engine's files. */
const CATALOG_PREFIXES = new Set(SETTINGS.map((setting) => setting.id.split(".")[0] ?? ""));

/** The mod's own id becomes a feed match, a path piece and every setting id's prefix - lowercase, no separators. */
const ID_SHAPE = /^[a-z0-9][a-z0-9.-]*$/;

/** Versions become path components and feed comparisons; the same bound the sfall names already pass. */
const VERSION_SHAPE = /^\d[\d.a-z-]*$/i;

/**
 * The same two bounds, for values that reach the install paths without a manifest to have passed - a record's
 * own id and version, which name a working directory. Exported rather than re-spelled there, so a mod's id
 * means one thing whichever side of the install it is read from.
 */
export const isModId = (text: string): boolean => ID_SHAPE.test(text);
export const isModVersion = (text: string): boolean => VERSION_SHAPE.test(text);

/** Invalid UTF-8 is a refusal, not replacement characters silently standing in for the real content. */
const decoder = new TextDecoder("utf-8", { fatal: true });

function refuse(why: string): never {
  throw new Error(`The manifest was refused: ${why}.`);
}

/** The wording the spec reserves for a capability this version does not implement. */
function needsNewerZax(what: string): never {
  throw new Error(`This mod needs a newer version of ZAX: ${what}.`);
}

/** Everything except tab and newline; text with the rest is not something to render anywhere. */
// eslint-disable-next-line no-control-regex -- matching control characters is this expression's whole job.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

function text(value: unknown, where: string, cap: number): string {
  if (typeof value !== "string") refuse(`${where} must be text`);
  if (value.length === 0) refuse(`${where} is empty`);
  if (value.length > cap) refuse(`${where} runs past ${cap} characters`);
  if (CONTROL.test(value)) refuse(`${where} contains control characters`);
  return value;
}

/**
 * A value written into or compared against a config file. YAML reads `on: 1` as a number, and requiring
 * authors to quote every literal is the kind of rule that fails silently, so numbers are accepted and become
 * the string the file carries.
 */
function literal(value: unknown, where: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value, where, SHORT_TEXT);
}

function record(value: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${where} must be a mapping`);
  const fields = value as Record<string, unknown>;
  for (const key of Object.keys(fields)) {
    if (!allowed.includes(key)) refuse(`${where} has an unknown field "${key}"`);
  }
  return fields;
}

function items(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) refuse(`${where} must be a list`);
  return value;
}

/**
 * A path from a manifest, confined to the install directory - the rule every path-shaped field passes
 * through, spec text rather than an implementation detail. Separators normalize to `/`; anything that could
 * resolve outside - absolute paths, drive letters, `..`, empty or self segments - refuses the manifest whole.
 */
function confinedPath(value: unknown, where: string): string {
  const path = text(value, where, SHORT_TEXT).replace(/\\/g, "/");
  if (path.startsWith("/") || path.includes(":")) refuse(`${where} ("${path}") leaves the game directory`);
  if (path.split("/").some((piece) => piece === "" || piece === "." || piece === ".."))
    refuse(`${where} ("${path}") leaves the game directory`);
  return path;
}

/** A relative path's segments, or null when it could resolve anywhere but inside the install directory. */
function segments(path: string): string[] | null {
  if (path.includes(":")) return null;
  const pieces = path.replace(/\\/g, "/").split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) return null;
  return pieces;
}

/**
 * Whether a relative path stays inside the install directory at all - no absolutes, no drive letters, no
 * `..`. The bound a base mod's paths pass, its installer owning the whole directory rather than one folder
 * inside it; every other mod passes the narrower one below.
 */
export function isConfined(path: string): boolean {
  const pieces = segments(path);
  return pieces !== null && pieces.length > 0;
}

/**
 * Whether a relative path stays confined under `mods/` - no escapes, no absolutes, at least one segment below
 * it. The one spec rule the manifest parser, the record reader and uninstall all judge by, so a tampered
 * record cannot name what a manifest could not.
 */
export function insideMods(path: string): boolean {
  const pieces = segments(path);
  return pieces !== null && pieces.length > 1 && (pieces[0] ?? "").toLowerCase() === "mods";
}

/** Whether a path sits at least one segment below a granted directory, compared as the engine compares. */
function below(path: string, directory: string): boolean {
  const pieces = segments(path);
  const root = segments(directory);
  if (pieces === null || root === null || pieces.length <= root.length) return false;
  return root.every((piece, at) => piece.toLowerCase() === (pieces[at] ?? "").toLowerCase());
}

/**
 * Whether a mod may write to a path: under `mods/` as every mod may, or below one of the directories ZAX
 * grants this one. The grant is ZAX's own list (`mod-grants.ts`), so a manifest cannot widen it by declaring
 * a path and neither can a hand-edited record - and it widens only where, never how far, since a granted
 * path is confined exactly as `mods/` is.
 */
export function mayWrite(path: string, granted: readonly string[]): boolean {
  return insideMods(path) || granted.some((directory) => below(path, directory));
}

/** A path a mod is allowed to write - under `mods/`, or inside what ZAX grants it by name. */
function writablePath(value: unknown, where: string, id: string, granted: readonly string[]): string {
  const path = confinedPath(value, where);
  if (!mayWrite(path, granted))
    refuse(
      `${where} ("${path}") is outside what ZAX grants ${id} - that grant is ZAX's to give, not the manifest's to claim`,
    );
  return path;
}

function parseGate(value: unknown, where: string): { id: string } & ValueTest {
  const fields = record(value, where, ["id", "is", "is-not"]);
  const id = text(fields["id"], `${where}'s id`, SHORT_TEXT);
  const has = (key: string) => fields[key] !== undefined;
  if (has("is") === has("is-not")) refuse(`${where} needs exactly one of "is" and "is-not"`);
  const values = items(fields[has("is") ? "is" : "is-not"], `${where}'s values`).map((entry, at) =>
    literal(entry, `${where}'s value ${at + 1}`),
  );
  return has("is") ? { id, is: values } : { id, isNot: values };
}

/** The fields each kind carries beyond the shared ones - the catalog's kind union, payloads included. */
const KIND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  scale: ["max"],
  bool: ["on", "off"],
  int: ["min", "max", "unit", "sentinels"],
  float: ["min", "max", "unit", "sentinels"],
  text: ["path"],
  choice: ["options"],
  key: [],
};

function bound(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) refuse(`${where} must be a number`);
  return value;
}

function parseSentinels(value: unknown, where: string): Record<string, string> {
  // The keys here are file values - data, not schema - so this is the one mapping with no field allowlist.
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`${where} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [raw, label] of Object.entries(value as Record<string, unknown>)) {
    out[raw] = text(label, `${where}["${raw}"]`, SHORT_TEXT);
  }
  return out;
}

function parseKind(fields: Record<string, unknown>, where: string): SettingKind | null {
  const type = text(fields["kind"], `${where}'s kind`, SHORT_TEXT);
  switch (type) {
    case "scale":
      return { type, max: bound(fields["max"], `${where}'s max`) };
    case "bool":
      // Omitted on/off mean 1/0 - what every ini bool in the corpus writes - so only the exceptions say so.
      return {
        type,
        onValue: fields["on"] === undefined ? "1" : literal(fields["on"], `${where}'s on`),
        offValue: fields["off"] === undefined ? "0" : literal(fields["off"], `${where}'s off`),
      };
    case "int":
    case "float": {
      return {
        type,
        ...(fields["min"] !== undefined ? { min: bound(fields["min"], `${where}'s min`) } : {}),
        ...(fields["max"] !== undefined ? { max: bound(fields["max"], `${where}'s max`) } : {}),
        ...(fields["unit"] !== undefined ? { unit: text(fields["unit"], `${where}'s unit`, SHORT_TEXT) } : {}),
        ...(fields["sentinels"] !== undefined
          ? { sentinels: parseSentinels(fields["sentinels"], `${where}'s sentinels`) }
          : {}),
      };
    }
    case "text":
      return { type, ...(fields["path"] === true ? { path: true } : {}) };
    case "choice": {
      const options = items(fields["options"], `${where}'s options`).map((option, at) => {
        const parts = record(option, `${where}'s option ${at + 1}`, ["value", "label", "help"]);
        return {
          value: literal(parts["value"], `${where}'s option ${at + 1} value`),
          label: text(parts["label"], `${where}'s option ${at + 1} label`, SHORT_TEXT),
          ...(parts["help"] !== undefined
            ? { help: text(parts["help"], `${where}'s option ${at + 1} help`, LONG_TEXT) }
            : {}),
        };
      });
      if (options.length === 0) refuse(`${where}'s options are empty`);
      return { type, options };
    }
    case "key":
      return { type };
    default:
      // Unreachable: the caller drops an entry whose kind is not a key of KIND_FIELDS, which is the same set
      // this switch covers. Kept so adding a kind to one and not the other cannot pass silently.
      return null;
  }
}

const ENTRY_FIELDS = ["file", "kind", "label", "help", "default", "gated-by"];

/** The address becomes the id verbatim, so its characters are bounded the way an id's are. */
const ADDRESS_SHAPE = /^[A-Za-z0-9._-]+$/;

interface ParsedSettings {
  settings: readonly ModSetting[];
  dropped: readonly DroppedSetting[];
}

/** Said once, because two guards below reach the same conclusion and a second copy would drift from this one. */
const unknownKind = (kind: string): string => `its kind "${kind}" is not one this version knows`;

/**
 * A flat mapping keyed by each entry's real address in the ini, `section.key`, split at the first dot - so a
 * section name cannot carry one, a key can. The id is the mod's id plus the address, verbatim - a gate names
 * a sibling with no transform - the same rule the catalog's generator applies to the engine's own files.
 */
function parseSettings(value: unknown, modId: string, granted: readonly string[]): ParsedSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`"settings" must be a mapping`);
  const out: ModSetting[] = [];
  const dropped: DroppedSetting[] = [];

  for (const [rawAddress, entry] of Object.entries(value as Record<string, unknown>)) {
    const address = text(rawAddress, `a "settings" address`, SHORT_TEXT);
    const where = `"settings" entry "${address}"`;
    const dot = address.indexOf(".");
    if (dot < 1 || dot === address.length - 1) refuse(`${where} is not a "section.key" address`);
    const section = address.slice(0, dot);
    const key = address.slice(dot + 1);

    const loose = entry as Record<string, unknown>;
    const kindName = typeof loose?.["kind"] === "string" ? loose["kind"] : "";
    if (!(kindName in KIND_FIELDS)) {
      // Dropped without checking its other fields, which is deliberate: they belong to a shape this version
      // has no rule for, and the strictness that refuses an unknown field is there to stop a misspelling
      // dropping a safety rule. This entry carries none, and it is going anyway.
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) refuse(`${where} must be a mapping`);
      dropped.push({ address, why: unknownKind(kindName) });
      continue;
    }
    const parts = record(entry, where, [...ENTRY_FIELDS, ...(KIND_FIELDS[kindName] ?? [])]);

    if (!ADDRESS_SHAPE.test(address)) refuse(`${where} cannot become an id`);
    // Cannot collide with a catalog id: the mod id's first piece was refused out of the catalog's prefixes.
    const id = `${modId}.${address}`;

    // Unreachable behind the check above, which covers the same set of kinds - narrowed rather than asserted,
    // so a kind added to one of the two and not the other drops a control instead of crashing.
    const kind = parseKind(parts, where);
    if (kind === null) {
      dropped.push({ address, why: unknownKind(kindName) });
      continue;
    }

    const setting: ModSetting = {
      id,
      file:
        parts["file"] === undefined
          ? `mods/${modId}.ini`
          : writablePath(parts["file"], `${where}'s file`, modId, granted),
      section,
      key,
      kind,
      label: text(parts["label"], `${where}'s label`, SHORT_TEXT),
      ...(parts["help"] !== undefined ? { help: text(parts["help"], `${where}'s help`, LONG_TEXT) } : {}),
      ...(parts["default"] !== undefined ? { default: literal(parts["default"], `${where}'s default`) } : {}),
    };
    if (parts["gated-by"] !== undefined) setting.gatedBy = parseGate(parts["gated-by"], `${where}'s gate`);
    out.push(setting);
  }

  // Judged after every entry exists, so a gate may name a sibling defined later in the file, and repeated
  // because dropping a control drops whatever waited on it. A control gated on something absent would render
  // but silently never take effect, which is the failure gates exist to prevent.
  let kept: readonly ModSetting[] = out;
  for (;;) {
    const ids = new Set(kept.map((setting) => setting.id));
    const shown = (setting: ModSetting) =>
      !setting.gatedBy || ids.has(setting.gatedBy.id) || CATALOG_IDS.has(setting.gatedBy.id);
    const survivors = kept.filter(shown);
    if (survivors.length === kept.length) break;
    for (const gone of kept.filter((setting) => !shown(setting)))
      dropped.push({
        address: `${gone.section}.${gone.key}`,
        why: `it waits on "${gone.gatedBy?.id ?? ""}", which this version cannot show`,
      });
    kept = survivors;
  }
  return { settings: kept, dropped };
}

/**
 * The mods-folder entries a mod declares. Each is confined the way every path-shaped field is, and kept as
 * written rather than prefixed with `mods/`: the order file's own lines start below that folder.
 */
function parseEntries(value: unknown, where: string): readonly string[] {
  const entries = items(value, where).map((name, at) => confinedPath(name, `${where} entry ${at + 1}`));
  if (entries.length === 0) refuse(`${where} is empty, which would order nothing while claiming to`);
  return entries;
}

const GROUP_FIELDS = ["label", "pick", "options"];
const PART_FIELDS = ["id", "label", "help", "archive", "entries", "needs"];

function parsePart(value: unknown, where: string): ModPart {
  const fields = record(value, where, PART_FIELDS);
  const id = text(fields["id"], `${where}'s id`, SHORT_TEXT);
  // The same bound the mod's own id passes: a part id is recorded, and a record is a file on disk.
  if (!ID_SHAPE.test(id)) refuse(`${where}'s id ("${id}") is not an id`);
  return {
    id,
    label: text(fields["label"], `${where}'s label`, SHORT_TEXT),
    ...(fields["help"] !== undefined ? { help: text(fields["help"], `${where}'s help`, LONG_TEXT) } : {}),
    archive: assetName(fields["archive"], `${where}'s archive`),
    ...(fields["entries"] !== undefined ? { entries: parseEntries(fields["entries"], `${where}'s entries`) } : {}),
    ...(fields["needs"] !== undefined ? { needs: text(fields["needs"], `${where}'s needs`, SHORT_TEXT) } : {}),
  };
}

/** Every part of a manifest, flat and in declared order - the shape a selection is judged against. */
export function partOptions(manifest: ModManifest): readonly ModPart[] {
  return (manifest.parts ?? []).flatMap((group) => group.options);
}

/**
 * A grouped choice, whatever is being chosen: the manifest's parts and the installer's components are the
 * same question in two places, and one reader keeps them the same question for the interface too.
 */
function parseGroups<T>(
  value: unknown,
  what: string,
  option: (raw: unknown, where: string) => T,
): readonly { label: string; pick: "one" | "any"; options: readonly T[] }[] {
  const groups = items(value, what).map((raw, at): { label: string; pick: "one" | "any"; options: readonly T[] } => {
    const where = `${what} group ${at + 1}`;
    const fields = record(raw, where, GROUP_FIELDS);
    const pick = text(fields["pick"], `${where}'s pick`, SHORT_TEXT);
    // On the refusing side of the ignorance rule, and the settings entries' opposite: `pick` decides what
    // lands on disk, so reading an unknown one as `any` would install what the author never described.
    if (pick !== "one" && pick !== "any")
      needsNewerZax(`a ${what} group picks "${pick}", which this version does not implement`);
    const options = items(fields["options"], `${where}'s options`).map((entry, i) =>
      option(entry, `${where} option ${i + 1}`),
    );
    if (options.length === 0) refuse(`${where} is empty, so it offers nothing to pick`);
    return { label: text(fields["label"], `${where}'s label`, SHORT_TEXT), pick, options };
  });
  if (groups.length === 0) refuse(`${what} is empty, so it offers nothing to pick`);
  return groups;
}

/**
 * The choices a release offers. Groups and options keep the order the manifest declares them in: that order
 * is the author's one lever over how the choice reads, and nothing here has a better one to impose.
 */
function parseParts(value: unknown): readonly ModPartGroup[] {
  const groups = parseGroups(value, `"parts"`, parsePart);

  // Unique across the manifest rather than per group: the recorded selection names ids flat, and a group is
  // no part of the address.
  const byId = new Map<string, ModPart>();
  for (const part of groups.flatMap((group) => group.options)) {
    if (byId.has(part.id)) refuse(`"parts" names "${part.id}" twice`);
    byId.set(part.id, part);
  }
  for (const part of byId.values()) {
    if (part.needs === undefined) continue;
    if (part.needs === part.id) refuse(`"${part.id}" needs itself, so it could never be selected`);
    if (!byId.has(part.needs)) refuse(`"${part.id}" needs "${part.needs}", which is not a part of this mod`);
    // A cycle is a set of parts none of which could ever be selected - said at publish time rather than at
    // the first install that tries.
    const seen = new Set([part.id]);
    for (let at: string | undefined = part.needs; at !== undefined; at = byId.get(at)?.needs) {
      if (seen.has(at)) refuse(`"${part.id}" and "${at}" need each other, so neither could ever be selected`);
      seen.add(at);
    }
  }
  return groups;
}

const COMPONENT_FIELDS = ["id", "label", "help", "required"];
const INSTALLER_PLATFORMS = ["windows", "other"];

/**
 * One component of the installer's own list. Its id is the installer's name for it rather than an id ZAX
 * mints, so the shapes ZAX bounds elsewhere do not apply - Inno spells a child component `walk_speed\low_fps`.
 * What is bounded is what the command line can carry: the names go into one comma-separated quoted argument,
 * and either character in a name would break that argument apart.
 */
function parseComponent(value: unknown, where: string): ModComponent {
  const fields = record(value, where, COMPONENT_FIELDS);
  const id = text(fields["id"], `${where}'s id`, SHORT_TEXT);
  if (/[",]/.test(id)) refuse(`${where}'s id ("${id}") cannot be passed to an installer`);
  return {
    id,
    label: text(fields["label"], `${where}'s label`, SHORT_TEXT),
    ...(fields["help"] !== undefined ? { help: text(fields["help"], `${where}'s help`, LONG_TEXT) } : {}),
    ...(fields["required"] === true ? { required: true } : {}),
  };
}

/**
 * How a base mod installs, per platform. An unknown platform key takes the newer-ZAX wording rather than the
 * unknown-field one, and so does an unknown `silent`: both decide what ZAX executes, and reading either as
 * "not for me" would run the wrong thing rather than nothing.
 */
function parseInstaller(value: unknown): ModInstaller {
  // Ahead of the unknown-field pass, the way a later spec is: a platform key this version has no name for is
  // a platform a newer ZAX runs on, and calling it a misspelling would send the reader to fix the manifest.
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!INSTALLER_PLATFORMS.includes(key))
        needsNewerZax(`its "installer" names the platform "${key}", which this version cannot run`);
    }
  }
  const platforms = record(value, `"installer"`, INSTALLER_PLATFORMS);

  const out: ModInstaller = {};
  if (platforms["windows"] !== undefined) {
    const fields = record(platforms["windows"], `"installer" windows`, ["asset", "silent", "components"]);
    const silent = text(fields["silent"], `"installer" windows silent`, SHORT_TEXT);
    if (silent !== "inno")
      needsNewerZax(`its Windows installer is run as "${silent}", which this version does not know how to run`);
    const components =
      fields["components"] === undefined
        ? undefined
        : parseGroups(fields["components"], `"components"`, parseComponent);
    const named = new Set<string>();
    for (const component of components?.flatMap((group) => group.options) ?? []) {
      if (named.has(component.id)) refuse(`"components" names "${component.id}" twice`);
      named.add(component.id);
    }
    out.windows = {
      asset: assetName(fields["asset"], `"installer" windows asset`),
      silent,
      ...(components ? { components } : {}),
    };
  }
  if (platforms["other"] !== undefined) {
    const fields = record(platforms["other"], `"installer" other`, ["asset", "run"]);
    out.other = {
      asset: assetName(fields["asset"], `"installer" other asset`),
      // Confined like every path-shaped field: it is run from inside the game directory after the payload
      // lands there, so a path leaving it would run something the payload never shipped.
      run: confinedPath(fields["run"], `"installer" other run`),
    };
  }
  if (out.windows === undefined && out.other === undefined)
    refuse(`"installer" names no platform, so there is nothing to run anywhere`);
  return out;
}

/**
 * The directory a creating mod makes. One segment, because it is the payload's own root and the bound every
 * later write is judged against: a name with a separator in it would be a bound with a path inside it, and
 * "confined to `Fallout1in2/games`" is not something a reader of the manifest would expect to have declared.
 */
function parseCreates(value: unknown): ModCreates {
  const fields = record(value, `"creates"`, ["directory"]);
  const directory = confinedPath(fields["directory"], `"creates" directory`);
  if (directory.includes("/"))
    refuse(`"creates" directory ("${directory}") is not one folder of the install it sits in`);
  return { directory };
}

const INPUT_FIELDS = ["id", "label", "help", "holds"];

/** What the user is asked for, each answer checked against a file the folder must hold. */
function parseInputs(value: unknown): readonly ModInput[] {
  const inputs = items(value, `"inputs"`).map((raw, at) => {
    const where = `"inputs" entry ${at + 1}`;
    const fields = record(raw, where, INPUT_FIELDS);
    const id = text(fields["id"], `${where}'s id`, SHORT_TEXT);
    // The same bound the mod's own id passes: it names an answer that reaches the install as a path.
    if (!ID_SHAPE.test(id)) refuse(`${where}'s id ("${id}") is not an id`);
    return {
      id,
      label: text(fields["label"], `${where}'s label`, SHORT_TEXT),
      ...(fields["help"] !== undefined ? { help: text(fields["help"], `${where}'s help`, LONG_TEXT) } : {}),
      // A file the folder holds, so a name rather than a path: what is checked is that folder, not a tree.
      holds: assetName(fields["holds"], `${where}'s holds`),
    };
  });
  if (inputs.length === 0) refuse(`"inputs" is empty, so it asks for nothing while claiming to`);
  const named = new Set<string>();
  for (const input of inputs) {
    if (named.has(input.id)) refuse(`"inputs" names "${input.id}" twice`);
    named.add(input.id);
  }
  return inputs;
}

function parseExtractDat(value: unknown, inputs: readonly ModInput[]): ModExtractDat {
  const fields = record(value, `"extract-dat"`, ["from", "list", "into"]);
  const from = text(fields["from"], `"extract-dat" from`, SHORT_TEXT);
  if (!inputs.some((input) => input.id === from))
    refuse(`"extract-dat" unpacks "${from}", which this mod does not ask for`);
  return {
    from,
    list: confinedPath(fields["list"], `"extract-dat" list`),
    into: confinedPath(fields["into"], `"extract-dat" into`),
  };
}

function parseRefuse(value: unknown): readonly RefuseRule[] {
  return items(value, `"refuse"`).map((rule, at) => {
    const where = `"refuse" entry ${at + 1}`;
    const fields = record(rule, where, ["when", "reason"]);
    const when = record(fields["when"], `${where}'s when`, ["present", "absent"]);
    const paths = (key: string) =>
      when[key] === undefined
        ? []
        : items(when[key], `${where}'s ${key}`).map((path, i) => confinedPath(path, `${where}'s ${key} ${i + 1}`));
    const present = paths("present");
    const absent = paths("absent");
    if (present.length === 0 && absent.length === 0) refuse(`${where} tests nothing`);
    return { present, absent, reason: text(fields["reason"], `${where}'s reason`, LONG_TEXT) };
  });
}

/** The payload asset's name becomes a filename in the working directory, so it must be one - no separators. */
function assetName(value: unknown, where: string): string {
  const name = text(value, where, SHORT_TEXT);
  if (/[\\/:]/.test(name) || name.startsWith(".")) refuse(`${where} ("${name}") is not a file name`);
  return name;
}

const MANIFEST_FIELDS = [
  "spec",
  "id",
  "name",
  "version",
  "game",
  "type",
  "reason",
  "archive",
  "install-on",
  "requires",
  "state",
  "entries",
  "parts",
  "becomes",
  "installer",
  "creates",
  "inputs",
  "extract-dat",
  "refuse",
  "settings",
  "install",
  "extra",
];

export function parseManifest(bytes: Uint8Array, defaults: ManifestDefaults = {}): ModManifest {
  if (bytes.byteLength > MANIFEST_BYTE_CAP)
    refuse(`it is ${bytes.byteLength} bytes, past the ${MANIFEST_BYTE_CAP} byte cap`);

  let root: unknown;
  try {
    root = parse(decoder.decode(bytes), { maxAliasCount: ALIAS_CAP });
  } catch (error) {
    refuse(`it does not parse (${error instanceof Error ? error.message.split("\n")[0] : "unreadable"})`);
  }

  // A later spec is answered ahead of everything else, the unknown-field pass included: that spec's whole
  // effect here is fields this version has no name for, and the answer to those is to update ZAX rather than
  // to name one of them a misspelling.
  const stated = root !== null && typeof root === "object" ? (root as Record<string, unknown>)["spec"] : undefined;
  if (typeof stated === "number" && Number.isInteger(stated) && stated > MANIFEST_SPEC)
    needsNewerZax(`it is written to manifest spec ${stated}, this version reads spec ${MANIFEST_SPEC}`);

  const fields = record(root, "the manifest", MANIFEST_FIELDS);

  // Everything after this is judged by this version's rules, so the number that selects them is checked here.
  const spec = fields["spec"];
  if (typeof spec !== "number" || !Number.isInteger(spec) || spec < 1)
    refuse(`"spec" is ${spec === undefined ? "missing" : JSON.stringify(spec)}, not a spec number`);

  if (fields["game"] !== "fallout2") refuse(`it is for "${String(fields["game"])}", not Fallout 2`);

  const id = text(fields["id"], `"id"`, SHORT_TEXT);
  if (!ID_SHAPE.test(id)) refuse(`"id" ("${id}") is not an id`);
  // The whole namespace, not just today's ids: a mod id inside a catalog prefix could mint setting ids that a
  // later catalog addition collides with, and a per-id check can only see the catalog as it is now.
  if (CATALOG_PREFIXES.has(id.split(".")[0] ?? id))
    refuse(`"id" ("${id}") is inside the catalog's "${id.split(".")[0]}" namespace`);
  // Read once, off the id: every path this manifest declares is judged against what ZAX grants that name.
  const granted = grantsFor(id);
  // Stated wins over supplied: a manifest published as an asset is the more specific claim, and the archive's
  // embedded copy is checked against it.
  const version = fields["version"] === undefined ? defaults.version : literal(fields["version"], `"version"`);
  if (version === undefined) refuse(`it states no "version", and its release supplies none`);
  if (!VERSION_SHAPE.test(version)) refuse(`"version" ("${version}") is not a version`);

  const type = fields["type"] === undefined ? "pluggable" : text(fields["type"], `"type"`, SHORT_TEXT);
  // The Fo1in2 operations are in the spec and not in this version - a capability a newer ZAX has.
  if (fields["install"] !== undefined)
    needsNewerZax("it describes an install procedure, which this version does not perform");
  if (type !== "pluggable" && type !== "permanent" && type !== "base")
    needsNewerZax(`"${type}" is not a mod type this version knows`);

  if (type === "permanent" && fields["reason"] === undefined)
    refuse(`a permanent mod must say why it cannot be uninstalled ("reason")`);
  if (type !== "permanent" && fields["reason"] !== undefined) refuse(`"reason" belongs to permanent mods alone`);

  // A base mod is the only one that names an installer or creates an install, and the only one that has to:
  // these fields are what makes the install something ZAX hands over, or performs, rather than stacks.
  for (const field of ["becomes", "installer", "creates"]) {
    if (type !== "base" && fields[field] !== undefined) refuse(`"${field}" belongs to a base mod alone`);
  }
  let becomes: GameType | undefined;
  let installer: ModInstaller | undefined;
  let creates: ModCreates | undefined;
  let inputs: readonly ModInput[] | undefined;
  let extractDat: ModExtractDat | undefined;
  if (type === "base") {
    // The two shapes of base mod, and a manifest is one or the other: an installer to hand the game over to,
    // or a directory to create beside it. Both would be two installs described as one; neither installs
    // nothing at all.
    if (fields["installer"] !== undefined && fields["creates"] !== undefined)
      refuse(`it names both an "installer" and what it "creates", which are the two ways of being a base mod`);
    if (fields["installer"] === undefined && fields["creates"] === undefined)
      refuse(`a base mod names no "installer" and creates nothing, so nothing could install it`);
    if (fields["installer"] !== undefined) installer = parseInstaller(fields["installer"]);
    if (fields["creates"] !== undefined) {
      creates = parseCreates(fields["creates"]);
      inputs = fields["inputs"] === undefined ? undefined : parseInputs(fields["inputs"]);
      extractDat =
        fields["extract-dat"] === undefined ? undefined : parseExtractDat(fields["extract-dat"], inputs ?? []);
    }
    // Required rather than defaulted to the id, which is what `mods.md` proposed: the two namespaces do not
    // coincide - RPU's id is "rpu" and the type it becomes is "fallout2rpu" - so that default would refuse
    // every real manifest. Named outright, and checked against the types this version can detect, since the
    // detected type is what every later gate reads.
    const named = text(fields["becomes"], `"becomes"`, SHORT_TEXT);
    if (!(named in GAME_TYPES))
      needsNewerZax(`"becomes" names the game type "${named}", which this version cannot detect`);
    becomes = named as GameType;
  }
  // Both belong to the install a mod creates, and neither means anything without one: an installer ZAX does
  // not run cannot be handed an answer, and there is nowhere for an extraction to land.
  for (const field of ["inputs", "extract-dat"]) {
    if (creates === undefined && fields[field] !== undefined)
      refuse(`"${field}" belongs to a mod that creates an install`);
  }

  let requiresSfall: string | undefined;
  if (fields["requires"] !== undefined) {
    const requires = record(fields["requires"], `"requires"`, ["sfall"]);
    const range = text(requires["sfall"], `"requires" sfall`, SHORT_TEXT);
    const match = /^>=\s*(\d[\d.a-z]*)$/i.exec(range);
    if (!match?.[1]) refuse(`"requires" sfall ("${range}") is not a ">=version" bound`);
    requiresSfall = match[1];
  }

  // Vanilla alone for a delegated base mod that says nothing - the direction both upstream scripts enforce
  // themselves, and the opposite of a stacking mod's silence, which means anywhere. A creating mod goes back
  // to anywhere: it writes only inside the directory it makes, so what the host already is does not reach it.
  let installOn: readonly GameType[] | undefined = installer !== undefined ? ["fallout2"] : undefined;
  if (fields["install-on"] !== undefined) {
    installOn = items(fields["install-on"], `"install-on"`).map((entry, at) => {
      const name = text(entry, `"install-on" entry ${at + 1}`, SHORT_TEXT);
      // A type this version has no marker for may be a future base mod's - the newer-ZAX case again.
      if (!(name in GAME_TYPES))
        needsNewerZax(`"install-on" names the game type "${name}", which this version cannot detect`);
      return name as GameType;
    });
    if (installOn.length === 0) refuse(`"install-on" is empty, which would install nowhere`);
  }

  const parts = fields["parts"] === undefined ? undefined : parseParts(fields["parts"]);
  if (parts && fields["archive"] !== undefined)
    refuse(`it states both "archive" and "parts", where each part names the asset it deploys`);
  if (parts && fields["entries"] !== undefined)
    refuse(`it states both "entries" and "parts", where each part declares what it puts in the mods folder`);
  // A release supplies its sole archive as a default. For a parts manifest that asset describes nothing this
  // install would deploy, so it is passed over rather than refused - the release did nothing wrong.
  const archive = fields["archive"] ?? (parts ? undefined : defaults.archive);

  return {
    id,
    name: text(fields["name"], `"name"`, SHORT_TEXT),
    version,
    type,
    ...(type === "permanent" ? { reason: text(fields["reason"], `"reason"`, LONG_TEXT) } : {}),
    ...(archive !== undefined ? { archive: assetName(archive, `"archive"`) } : {}),
    ...(installOn !== undefined ? { installOn } : {}),
    ...(becomes !== undefined ? { becomes } : {}),
    ...(installer !== undefined ? { installer } : {}),
    ...(creates !== undefined ? { creates } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...(extractDat !== undefined ? { extractDat } : {}),
    ...(requiresSfall !== undefined ? { requiresSfall } : {}),
    ...(fields["state"] !== undefined
      ? {
          state: items(fields["state"], `"state"`).map((path, at) =>
            writablePath(path, `"state" entry ${at + 1}`, id, granted),
          ),
        }
      : {}),
    ...(fields["entries"] !== undefined ? { entries: parseEntries(fields["entries"], `"entries"`) } : {}),
    ...(parts !== undefined ? { parts } : {}),
    refuse: fields["refuse"] === undefined ? [] : parseRefuse(fields["refuse"]),
    ...(fields["settings"] === undefined
      ? { settings: [], dropped: [] }
      : parseSettings(fields["settings"], id, granted)),
  };
}
