/**
 * `f2mod.yml`: the manifest a mod's release carries and this application interprets. It is read from the
 * repository at the release's tag, so `version` and `archive` may be absent from the file and supplied by the
 * release instead.
 *
 * Parsing is strict and every refusal names its cause. A manifest is downloaded data even from a trusted
 * publisher, so it gets a boundary of its own: a size cap before parsing, a YAML alias cap, length-capped
 * plain-text strings, and confinement for every path-shaped field. An unknown field refuses rather than
 * passes, so a misspelling cannot silently drop a safety check. Anything the format defines that this version
 * does not implement - a base mod's install procedure, a later spec - refuses as "needs a newer ZAX" rather
 * than half-installing.
 */

import { parse } from "yaml";
import {
  isGameType,
  isRecord,
  ownTarget,
  type GameType,
  type SettingDef,
  type SettingKind,
  type SettingTarget,
  type ValueTest,
} from "@zax/core";
import { SETTINGS } from "./catalog.js";
import { grantsFor } from "./mod-grants.js";

/**
 * The file's name at the repository root. It is not manager-branded: the manifest declares its own `game`,
 * and a second manager reading this format should not have to ship a file named after this application.
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

interface ConflictRule {
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
 * How a base mod installs, per platform. Both routes exist because upstream publishes both, and they are not
 * the same install: the Windows one is an installer program that takes the game directory as an argument,
 * while the other is a payload extracted over the game with a script inside it that finishes the job.
 */
interface ModInstaller {
  windows?: {
    /**
     * Absent where the release names it: upstream's installer assets carry the version in their names, which
     * only the release knows, so a route that states none is matched against what the release published. The
     * name stays in the format for a release whose assets leave the choice open.
     */
    asset?: string;
    /**
     * The toolkit the installer was built with, which is what says how to drive it. A fact about the asset
     * rather than about the invocation, so it stays true as the command line changes. `inno` is the only one
     * this version knows.
     */
    builtWith: "inno";
  };
  other?: {
    asset?: string;
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
interface ModExtractDat {
  /** The input whose `holds` file is unpacked. */
  from: string;
  /** The file naming what to lift out of it, one path per line. */
  list: string;
  into: string;
}

/**
 * Where a mod says it loads, named in the vocabulary the order file itself uses - entries under `mods/`,
 * rather than mod ids. That is the only vocabulary every line can be judged in: the folder cannot say which
 * mod put a dat there, so an id would place a mod against the ones ZAX installed and against nothing else.
 *
 * Stated as override rather than position, because position is not what the file decides: order in
 * `mods_order.txt` has no effect except which copy of a shared file the engine sees, so what a mod overrides
 * is the whole of what its place means - and a reader never has to know which end of the file wins.
 */
interface ModOrder {
  overrides: readonly string[];
  overriddenBy: readonly string[];
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  /**
   * What the mod is and who wrote it, for the surface that offers it. None of it reaches the install: a
   * manifest that says nothing here is a mod shown by name alone, which is what every one of them was before
   * the fields existed.
   */
  author?: string;
  description?: string;
  /** Where the mod is discussed and where it lives, which the interface offers to open. */
  forum?: string;
  homepage?: string;
  type: ModType;
  /** Why the mod can never be uninstalled. Present exactly when the type is permanent. */
  reason?: string;
  /** The release asset carrying the payload. Absent where the release's sole archive supplied it. */
  archive?: string;
  /** `needs.game`: the types it installs on. Absent means any - a base mod's default is vanilla alone. */
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
  /** `needs.sfall`: the lowest version it works with, answered by the updater rather than a refusal. */
  requiresSfall?: string;
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
  /** What the mod says it loads either side of. Absent leaves its place to the shipped recommendation. */
  order?: ModOrder;
  /** Installs ZAX refuses because the author declared the clash. A file collision is caught without one. */
  conflicts: readonly ConflictRule[];
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
  if (!isRecord(value)) refuse(`${where} must be a mapping`);
  const fields = value;
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
  if (!isRecord(value)) refuse(`${where} must be a mapping`);
  const out: Record<string, string> = {};
  for (const [raw, label] of Object.entries(value)) {
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
  if (!isRecord(value)) refuse(`"settings" must be a mapping`);
  const out: ModSetting[] = [];
  const dropped: DroppedSetting[] = [];

  for (const [rawAddress, entry] of Object.entries(value)) {
    const address = text(rawAddress, `a "settings" address`, SHORT_TEXT);
    const where = `"settings" entry "${address}"`;
    const dot = address.indexOf(".");
    if (dot < 1 || dot === address.length - 1) refuse(`${where} is not a "section.key" address`);
    const section = address.slice(0, dot);
    const key = address.slice(dot + 1);

    const loose = isRecord(entry) ? entry : {};
    const kindName = typeof loose["kind"] === "string" ? loose["kind"] : "";
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

    // A mod setting writes one address: the manifest format names a single file, section and key, and
    // linking across engines is the catalog's business rather than something a mod declares.
    const target: SettingTarget = {
      file:
        parts["file"] === undefined
          ? `mods/${modId}.ini`
          : writablePath(parts["file"], `${where}'s file`, modId, granted),
      section,
      key,
      ...(parts["gated-by"] !== undefined ? { gatedBy: parseGate(parts["gated-by"], `${where}'s gate`) } : {}),
    };
    const setting: ModSetting = {
      id,
      targets: [target],
      kind,
      label: text(parts["label"], `${where}'s label`, SHORT_TEXT),
      ...(parts["help"] !== undefined ? { help: text(parts["help"], `${where}'s help`, LONG_TEXT) } : {}),
      ...(parts["default"] !== undefined ? { default: literal(parts["default"], `${where}'s default`) } : {}),
    };
    out.push(setting);
  }

  // Judged after every entry exists, so a gate may name a sibling defined later in the file, and repeated
  // because dropping a control drops whatever waited on it. A control gated on something absent would render
  // but silently never take effect, which is the failure gates exist to prevent.
  let kept: readonly ModSetting[] = out;
  for (;;) {
    const ids = new Set(kept.map((setting) => setting.id));
    const shown = (setting: ModSetting) => {
      const gate = ownTarget(setting).gatedBy;
      return !gate || ids.has(gate.id) || CATALOG_IDS.has(gate.id);
    };
    const survivors = kept.filter(shown);
    if (survivors.length === kept.length) break;
    for (const gone of kept.filter((setting) => !shown(setting))) {
      const at = ownTarget(gone);
      dropped.push({
        address: `${at.section}.${at.key}`,
        why: `it waits on "${at.gatedBy?.id ?? ""}", which this version cannot show`,
      });
    }
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

/**
 * What the mod's files win over, and what wins over them. Both lists are entries under `mods/`, spelled as
 * the order file spells them, so they are read exactly as `entries` is.
 *
 * A claim naming nothing refuses: it would read as a mod stating its place while placing itself nowhere. What
 * a claim names is not required to be present - a mod may state where it goes beside something this install
 * does not have - so an absent name is what leaves the claim unsatisfied rather than what refuses it.
 */
function parseOrder(fields: Record<string, unknown>): ModOrder {
  const names = (key: string) =>
    fields[`order.${key}`] === undefined
      ? []
      : items(fields[`order.${key}`], `"order.${key}"`).map((name, at) =>
          confinedPath(name, `"order.${key}" entry ${at + 1}`),
        );
  const overrides = names("overrides");
  const overriddenBy = names("overridden-by");
  if (overrides.length === 0 && overriddenBy.length === 0)
    refuse(`"order" names nothing to override and nothing to be overridden by, so it states no place`);
  return { overrides, overriddenBy };
}

const PART_GROUP_FIELDS = ["id", "label", "pick"];
const PART_FIELDS = ["id", "group", "label", "help", "archive", "entries", "needs"];

/** One part, from the mapping its list entry holds - already checked for fields this version has no name for. */
function parsePart(fields: Record<string, unknown>, where: string): ModPart {
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
 * The choices a release offers, from the two lists that declare them: `part-groups` holds the headers and
 * `parts` the options, each naming the group it sits in. Two flat lists rather than one nested one because a
 * group inside a list is the nesting this format does not have - and unlike every other wrapper here, a list
 * inside a list is not something a dotted key can spell.
 *
 * Both keep the order the manifest declares them in: that order is the author's one lever over how the choice
 * reads, and nothing here has a better one to impose. Group ids are read back out by nothing - no record
 * carries one - so renaming a group breaks no install, which is the opposite of a part id.
 */
function parseParts(groupsValue: unknown, partsValue: unknown): readonly ModPartGroup[] {
  const declared = items(groupsValue, `"part-groups"`).map(
    (raw, at): { id: string } & Omit<ModPartGroup, "options"> => {
      const where = `"part-groups" entry ${at + 1}`;
      const fields = record(raw, where, PART_GROUP_FIELDS);
      const id = text(fields["id"], `${where}'s id`, SHORT_TEXT);
      if (!ID_SHAPE.test(id)) refuse(`${where}'s id ("${id}") is not an id`);
      const pick = text(fields["pick"], `${where}'s pick`, SHORT_TEXT);
      // On the refusing side of the ignorance rule, and the settings entries' opposite: `pick` decides what
      // lands on disk, so reading an unknown one as `any` would install what the author never described.
      if (pick !== "one" && pick !== "any")
        needsNewerZax(`a "part-groups" entry picks "${pick}", which this version does not implement`);
      return { id, label: text(fields["label"], `${where}'s label`, SHORT_TEXT), pick };
    },
  );
  if (declared.length === 0) refuse(`"part-groups" is empty, so it groups nothing`);

  const held = new Map<string, ModPart[]>();
  for (const group of declared) {
    if (held.has(group.id)) refuse(`"part-groups" names "${group.id}" twice`);
    held.set(group.id, []);
  }

  const byId = new Map<string, ModPart>();
  for (const [at, raw] of items(partsValue, `"parts"`).entries()) {
    const where = `"parts" entry ${at + 1}`;
    const fields = record(raw, where, PART_FIELDS);
    const group = text(fields["group"], `${where}'s group`, SHORT_TEXT);
    const into = held.get(group);
    // Resolved the way a part's own `needs`, `extract-dat.from` and a setting's `gated-by` resolve: a name
    // that matches nothing refuses, rather than leaving an option in a group the interface cannot draw.
    if (into === undefined) refuse(`${where} is in the group "${group}", which "part-groups" does not declare`);
    const part = parsePart(fields, where);
    // Unique across the manifest rather than per group: the recorded selection names ids flat, and a group is
    // no part of the address.
    if (byId.has(part.id)) refuse(`"parts" names "${part.id}" twice`);
    byId.set(part.id, part);
    into.push(part);
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

  // A group nothing joined would draw a heading over an empty box. Said against the group rather than the
  // parts, because what is missing is a part naming it and the group is the thing the author can see.
  for (const group of declared) {
    if (held.get(group.id)?.length === 0) refuse(`no part is in the group "${group.id}", so it offers nothing to pick`);
  }
  return declared.map((group) => ({ label: group.label, pick: group.pick, options: held.get(group.id) ?? [] }));
}

/**
 * How a base mod installs, per platform. An unknown platform takes the newer-ZAX wording rather than the
 * unknown-field one, and so does an unknown `built-with`: both decide what ZAX executes, and reading either as
 * "not for me" would run the wrong thing rather than nothing.
 *
 * Read straight off the manifest's own keys, since the platform now sits inside the key rather than under it.
 * That is also why the newer-ZAX check cannot wait for the unknown-field pass: `installer.haiku.run` would
 * otherwise be reported as a misspelling, sending the reader to fix a manifest that is correct.
 */
function parseInstaller(fields: Record<string, unknown>): ModInstaller {
  const out: ModInstaller = {};

  if (fields["installer.windows.built-with"] !== undefined || fields["installer.windows.asset"] !== undefined) {
    const builtWith = text(fields["installer.windows.built-with"], `"installer.windows.built-with"`, SHORT_TEXT);
    if (builtWith !== "inno")
      needsNewerZax(`its Windows installer was built with "${builtWith}", which this version cannot run`);
    const asset = fields["installer.windows.asset"];
    out.windows = {
      ...(asset !== undefined ? { asset: assetName(asset, `"installer.windows.asset"`) } : {}),
      builtWith,
    };
  }

  if (fields["installer.other.run"] !== undefined || fields["installer.other.asset"] !== undefined) {
    const asset = fields["installer.other.asset"];
    out.other = {
      ...(asset !== undefined ? { asset: assetName(asset, `"installer.other.asset"`) } : {}),
      // Confined like every path-shaped field: it is run from inside the game directory after the payload
      // lands there, so a path leaving it would run something the payload never shipped.
      run: confinedPath(fields["installer.other.run"], `"installer.other.run"`),
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
  const directory = confinedPath(value, `"creates.directory"`);
  if (directory.includes("/"))
    refuse(`"creates.directory" ("${directory}") is not one folder of the install it sits in`);
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

function parseExtractDat(fields: Record<string, unknown>, inputs: readonly ModInput[]): ModExtractDat {
  const from = text(fields["extract-dat.from"], `"extract-dat.from"`, SHORT_TEXT);
  if (!inputs.some((input) => input.id === from))
    refuse(`"extract-dat.from" names "${from}", which this mod does not ask for`);
  return {
    from,
    list: confinedPath(fields["extract-dat.list"], `"extract-dat.list"`),
    into: confinedPath(fields["extract-dat.into"], `"extract-dat.into"`),
  };
}

function parseConflicts(value: unknown): readonly ConflictRule[] {
  return items(value, `"conflicts"`).map((rule, at) => {
    const where = `"conflicts" entry ${at + 1}`;
    const fields = record(rule, where, ["present", "absent", "reason"]);
    const paths = (key: string) =>
      fields[key] === undefined
        ? []
        : items(fields[key], `${where}'s ${key}`).map((path, i) => confinedPath(path, `${where}'s ${key} ${i + 1}`));
    const present = paths("present");
    const absent = paths("absent");
    if (present.length === 0 && absent.length === 0) refuse(`${where} tests nothing`);
    return { present, absent, reason: text(fields["reason"], `${where}'s reason`, LONG_TEXT) };
  });
}

/**
 * An address the interface offers to open. `https` alone, and no whitespace: the value is handed to whatever
 * the machine opens links with, so any other scheme would be a manifest choosing what runs there rather than
 * naming a page to read.
 */
function link(value: unknown, where: string): string {
  const url = text(value, where, SHORT_TEXT);
  if (!/^https:\/\/[^\s]+$/.test(url)) refuse(`${where} ("${url}") is not an https address`);
  return url;
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
  "author",
  "description",
  "forum",
  "homepage",
  "game",
  "type",
  "reason",
  "archive",
  "needs.game",
  "needs.sfall",
  "entries",
  "order.overrides",
  "order.overridden-by",
  "part-groups",
  "parts",
  "becomes",
  "installer.windows.asset",
  "installer.windows.built-with",
  "installer.other.asset",
  "installer.other.run",
  "creates.directory",
  "inputs",
  "extract-dat.from",
  "extract-dat.list",
  "extract-dat.into",
  "conflicts",
  "settings",
  "install",
];

/**
 * Whether the manifest states anything under a dotted prefix - `installer`, `order`, `extract-dat`. What the
 * nested format answered with one key's presence now takes a scan, since the group it stood for is spelled
 * across several keys and any one of them means the author declared it.
 */
const states = (fields: Record<string, unknown>, prefix: string): boolean =>
  Object.keys(fields).some((key) => key.startsWith(`${prefix}.`));

/** Every platform the manifest names an installer for, in the order it names them. */
const installerPlatforms = (root: unknown): string[] => {
  if (!isRecord(root)) return [];
  const seen: string[] = [];
  for (const key of Object.keys(root)) {
    const platform = key.startsWith("installer.") ? key.split(".")[1] : undefined;
    if (platform !== undefined && platform !== "" && !seen.includes(platform)) seen.push(platform);
  }
  return seen;
};

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
  const stated = isRecord(root) ? root["spec"] : undefined;
  if (typeof stated === "number" && Number.isInteger(stated) && stated > MANIFEST_SPEC)
    needsNewerZax(`it is written to manifest spec ${stated}, this version reads spec ${MANIFEST_SPEC}`);

  // Ahead of the unknown-field pass for the same reason a later spec is: a platform this version has no name
  // for is one a newer ZAX runs on, and `installer.haiku.run` would otherwise be reported as a misspelling.
  for (const platform of installerPlatforms(root)) {
    if (platform !== "windows" && platform !== "other")
      needsNewerZax(`its "installer" names the platform "${platform}", which this version cannot run`);
  }

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
  // Stated wins over supplied: what the file says is the author's own claim, where the tag and the release's
  // assets are ZAX reading the release for one.
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
  const hasInstaller = states(fields, "installer");
  const hasCreates = fields["creates.directory"] !== undefined;
  for (const [what, stated] of [
    ["becomes", fields["becomes"] !== undefined],
    ["installer", hasInstaller],
    ["creates", hasCreates],
  ] as const) {
    if (type !== "base" && stated) refuse(`"${what}" belongs to a base mod alone`);
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
    if (hasInstaller && hasCreates)
      refuse(`it names both an "installer" and what it "creates", which are the two ways of being a base mod`);
    if (!hasInstaller && !hasCreates)
      refuse(`a base mod names no "installer" and creates nothing, so nothing could install it`);
    if (hasInstaller) installer = parseInstaller(fields);
    if (hasCreates) {
      creates = parseCreates(fields["creates.directory"]);
      inputs = fields["inputs"] === undefined ? undefined : parseInputs(fields["inputs"]);
      extractDat = states(fields, "extract-dat") ? parseExtractDat(fields, inputs ?? []) : undefined;
    }
    // Required rather than defaulted to the id, which is what `mods.md` proposed: the two namespaces do not
    // coincide - RPU's id is "rpu" and the type it becomes is "fallout2rpu" - so that default would refuse
    // every real manifest. Named outright, and checked against the types this version can detect, since the
    // detected type is what every later gate reads.
    const named = text(fields["becomes"], `"becomes"`, SHORT_TEXT);
    if (!isGameType(named)) needsNewerZax(`"becomes" names the game type "${named}", which this version cannot detect`);
    becomes = named;
  }
  // Both belong to the install a mod creates, and neither means anything without one: an installer ZAX does
  // not run cannot be handed an answer, and there is nowhere for an extraction to land.
  for (const [what, stated] of [
    ["inputs", fields["inputs"] !== undefined],
    ["extract-dat", states(fields, "extract-dat")],
  ] as const) {
    if (creates === undefined && stated) refuse(`"${what}" belongs to a mod that creates an install`);
  }

  // Vanilla alone for a delegated base mod that says nothing - the direction both upstream scripts enforce
  // themselves, and the opposite of a stacking mod's silence, which means anywhere. A creating mod goes back
  // to anywhere: it writes only inside the directory it makes, so what the host already is does not reach it.
  let installOn: readonly GameType[] | undefined = installer !== undefined ? ["fallout2"] : undefined;
  let requiresSfall: string | undefined;
  // Two keys under one prefix rather than the two unrelated fields this began as: the game under the mod and
  // the sfall beside it are the same question asked of the same install, answered at the same gate before
  // anything is offered, and the prefix is what still says so now that the wrapper is gone.
  if (fields["needs.game"] !== undefined) {
    installOn = items(fields["needs.game"], `"needs.game"`).map((entry, at) => {
      const name = text(entry, `"needs.game" entry ${at + 1}`, SHORT_TEXT);
      // A type this version has no marker for may be a future base mod's - the newer-ZAX case again.
      if (!isGameType(name)) needsNewerZax(`"needs.game" names the type "${name}", which this version cannot detect`);
      return name;
    });
    if (installOn.length === 0) refuse(`"needs.game" is empty, which would install nowhere`);
  }
  if (fields["needs.sfall"] !== undefined) {
    // A bare version, read as "this or newer", because that is the only bound ZAX acts on: an operator here
    // would promise comparisons - a ceiling, an exact pin - that nothing downstream implements.
    const stated = text(fields["needs.sfall"], `"needs.sfall"`, SHORT_TEXT);
    if (!/^\d[\d.a-z]*$/i.test(stated)) refuse(`"needs.sfall" ("${stated}") is not a version`);
    requiresSfall = stated;
  }

  // Declared together or not at all: groups with no parts head nothing, and parts with no groups sit in a
  // group that does not exist - which the per-part check below would report one option at a time.
  if ((fields["part-groups"] === undefined) !== (fields["parts"] === undefined))
    refuse(`"part-groups" and "parts" are declared together - one without the other describes half a choice`);
  const parts = fields["parts"] === undefined ? undefined : parseParts(fields["part-groups"], fields["parts"]);
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
    ...(fields["author"] !== undefined ? { author: text(fields["author"], `"author"`, SHORT_TEXT) } : {}),
    ...(fields["description"] !== undefined
      ? { description: text(fields["description"], `"description"`, LONG_TEXT) }
      : {}),
    ...(fields["forum"] !== undefined ? { forum: link(fields["forum"], `"forum"`) } : {}),
    ...(fields["homepage"] !== undefined ? { homepage: link(fields["homepage"], `"homepage"`) } : {}),
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
    ...(fields["entries"] !== undefined ? { entries: parseEntries(fields["entries"], `"entries"`) } : {}),
    ...(parts !== undefined ? { parts } : {}),
    ...(states(fields, "order") ? { order: parseOrder(fields) } : {}),
    conflicts: fields["conflicts"] === undefined ? [] : parseConflicts(fields["conflicts"]),
    ...(fields["settings"] === undefined
      ? { settings: [], dropped: [] }
      : parseSettings(fields["settings"], id, granted)),
  };
}
