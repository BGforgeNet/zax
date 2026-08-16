/**
 * `zax-mod.yml`: the manifest a mod's release carries and this application interprets. A release ships two
 * byte-identical copies - one at the archive root, one as a standalone asset - and this parser reads both.
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

/** The file's name at the archive root, and the release asset's name - the same on purpose. */
export const MANIFEST_NAME = "zax-mod.yml";

/**
 * Refused before parsing. A catalog-parity settings schema with help text runs tens of kilobytes; something
 * past this is not a manifest, whatever it is.
 */
export const MANIFEST_BYTE_CAP = 256 * 1024;

/** Anchors and aliases past this refuse - an alias flood multiplies in memory, not on the wire. */
const ALIAS_CAP = 64;

const SHORT_TEXT = 200;
const LONG_TEXT = 1000;

/** A mod setting is a catalog definition plus the value the release ships, kept for revert and display. */
export interface ModSetting extends SettingDef {
  default?: string;
}

export interface RefuseRule {
  /** Fires when every `present` path exists and every `absent` path does not. At least one list is non-empty. */
  present: readonly string[];
  absent: readonly string[];
  reason: string;
}

export interface ModManifest {
  id: string;
  name: string;
  version: string;
  type: "pluggable" | "permanent";
  /** Why the mod can never be uninstalled. Present exactly when the type is permanent. */
  reason?: string;
  /** The release asset carrying the payload, stamped by CI. An authored file has none; installing needs it. */
  archive?: string;
  /** Game types the mod installs on. Absent means any - the stacking default. */
  installOn?: readonly GameType[];
  /** The lowest sfall version the mod works with, answered by the updater rather than a refusal. */
  requiresSfall?: string;
  /** Files that belong to the user and survive upgrades by merging. Absent means every payload `.ini`. */
  state?: readonly string[];
  refuse: readonly RefuseRule[];
  settings: readonly ModSetting[];
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

/**
 * Whether a relative path stays confined under `mods/` - no escapes, no absolutes, at least one segment below
 * it. The one spec rule the manifest parser, the record reader and uninstall all judge by, so a tampered
 * record cannot name what a manifest could not.
 */
export function insideMods(path: string): boolean {
  if (path.includes(":")) return false;
  const pieces = path.replace(/\\/g, "/").split("/");
  if (pieces.some((piece) => piece === "" || piece === "." || piece === "..")) return false;
  return pieces.length > 1 && (pieces[0] ?? "").toLowerCase() === "mods";
}

/** Stacking mods live under `mods/`; a path elsewhere is a spec violation, not a creative layout. */
function modsPath(value: unknown, where: string): string {
  const path = confinedPath(value, where);
  if (!insideMods(path)) refuse(`${where} ("${path}") is not under mods/`);
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

function parseKind(fields: Record<string, unknown>, where: string): SettingKind {
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
      // A kind this version has never heard of is the settings schema's form of an unknown op.
      return needsNewerZax(`${where}'s kind "${type}" is not one this version knows`);
  }
}

const ENTRY_FIELDS = ["file", "kind", "label", "help", "default", "gated-by"];

/** The address becomes the id verbatim, so its characters are bounded the way an id's are. */
const ADDRESS_SHAPE = /^[A-Za-z0-9._-]+$/;

/**
 * A flat mapping keyed by each entry's real address in the ini, `section.key`, split at the first dot - so a
 * section name cannot carry one, a key can. The id is the mod's id plus the address, verbatim - a gate names
 * a sibling with no transform - the same rule the catalog's generator applies to the engine's own files.
 */
function parseSettings(value: unknown, modId: string): readonly ModSetting[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(`"settings" must be a mapping`);
  const out: ModSetting[] = [];
  const gates: { setting: ModSetting; where: string }[] = [];

  for (const [rawAddress, entry] of Object.entries(value as Record<string, unknown>)) {
    const address = text(rawAddress, `a "settings" address`, SHORT_TEXT);
    const where = `"settings" entry "${address}"`;
    const dot = address.indexOf(".");
    if (dot < 1 || dot === address.length - 1) refuse(`${where} is not a "section.key" address`);
    const section = address.slice(0, dot);
    const key = address.slice(dot + 1);

    const loose = entry as Record<string, unknown>;
    const kindName = typeof loose?.["kind"] === "string" ? loose["kind"] : "";
    const parts = record(entry, where, [...ENTRY_FIELDS, ...(KIND_FIELDS[kindName] ?? [])]);

    if (!ADDRESS_SHAPE.test(address)) refuse(`${where} cannot become an id`);
    // Cannot collide with a catalog id: the mod id's first piece was refused out of the catalog's prefixes.
    const id = `${modId}.${address}`;

    const setting: ModSetting = {
      id,
      file: parts["file"] === undefined ? `mods/${modId}.ini` : modsPath(parts["file"], `${where}'s file`),
      section,
      key,
      kind: parseKind(parts, where),
      label: text(parts["label"], `${where}'s label`, SHORT_TEXT),
      ...(parts["help"] !== undefined ? { help: text(parts["help"], `${where}'s help`, LONG_TEXT) } : {}),
      ...(parts["default"] !== undefined ? { default: literal(parts["default"], `${where}'s default`) } : {}),
    };
    if (parts["gated-by"] !== undefined) {
      setting.gatedBy = parseGate(parts["gated-by"], `${where}'s gate`);
      gates.push({ setting, where });
    }
    out.push(setting);
  }

  // After every entry exists, so a gate may name a sibling defined later in the file. An id neither here nor
  // in the catalog refuses: a control gated on nothing would render but silently never take effect, which is
  // the failure gates exist to prevent - and a genuinely newer catalog id means a newer ZAX has it.
  const ids = new Set(out.map((setting) => setting.id));
  for (const { setting, where } of gates) {
    const target = setting.gatedBy?.id ?? "";
    if (!ids.has(target) && !CATALOG_IDS.has(target))
      needsNewerZax(`${where} names "${target}", which is not a setting this version knows`);
  }
  return out;
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
function assetName(value: unknown): string {
  const name = text(value, `"archive"`, SHORT_TEXT);
  if (/[\\/:]/.test(name) || name.startsWith(".")) refuse(`"archive" ("${name}") is not a file name`);
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
  "refuse",
  "settings",
  "install",
  "extra",
];

export function parseManifest(bytes: Uint8Array): ModManifest {
  if (bytes.byteLength > MANIFEST_BYTE_CAP)
    refuse(`it is ${bytes.byteLength} bytes, past the ${MANIFEST_BYTE_CAP} byte cap`);

  let root: unknown;
  try {
    root = parse(decoder.decode(bytes), { maxAliasCount: ALIAS_CAP });
  } catch (error) {
    refuse(`it does not parse (${error instanceof Error ? error.message.split("\n")[0] : "unreadable"})`);
  }

  const fields = record(root, "the manifest", MANIFEST_FIELDS);

  // Spec first: everything after it is judged by this version's rules, which a later spec may have changed.
  if (fields["spec"] !== 1)
    needsNewerZax(`it is written to manifest spec ${String(fields["spec"])}, this version reads spec 1`);

  if (fields["game"] !== "fallout2") refuse(`it is for "${String(fields["game"])}", not Fallout 2`);

  const id = text(fields["id"], `"id"`, SHORT_TEXT);
  if (!ID_SHAPE.test(id)) refuse(`"id" ("${id}") is not an id`);
  // The whole namespace, not just today's ids: a mod id inside a catalog prefix could mint setting ids that a
  // later catalog addition collides with, and a per-id check can only see the catalog as it is now.
  if (CATALOG_PREFIXES.has(id.split(".")[0] ?? id))
    refuse(`"id" ("${id}") is inside the catalog's "${id.split(".")[0]}" namespace`);
  const version = literal(fields["version"], `"version"`);
  if (!VERSION_SHAPE.test(version)) refuse(`"version" ("${version}") is not a version`);

  const type = fields["type"] === undefined ? "pluggable" : text(fields["type"], `"type"`, SHORT_TEXT);
  // Base mods are in the spec; installing one is not in this version. The same words as an unknown type,
  // because from here the two are the same fact: a capability a newer ZAX has.
  if (type === "base" || fields["install"] !== undefined)
    needsNewerZax("it is a base mod, and this version installs pluggable and permanent mods only");
  if (type !== "pluggable" && type !== "permanent") needsNewerZax(`"${type}" is not a mod type this version knows`);

  if (type === "permanent" && fields["reason"] === undefined)
    refuse(`a permanent mod must say why it cannot be uninstalled ("reason")`);
  if (type === "pluggable" && fields["reason"] !== undefined) refuse(`"reason" belongs to permanent mods alone`);

  let requiresSfall: string | undefined;
  if (fields["requires"] !== undefined) {
    const requires = record(fields["requires"], `"requires"`, ["sfall"]);
    const range = text(requires["sfall"], `"requires" sfall`, SHORT_TEXT);
    const match = /^>=\s*(\d[\d.a-z]*)$/i.exec(range);
    if (!match?.[1]) refuse(`"requires" sfall ("${range}") is not a ">=version" bound`);
    requiresSfall = match[1];
  }

  let installOn: readonly GameType[] | undefined;
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

  return {
    id,
    name: text(fields["name"], `"name"`, SHORT_TEXT),
    version,
    type,
    ...(type === "permanent" ? { reason: text(fields["reason"], `"reason"`, LONG_TEXT) } : {}),
    ...(fields["archive"] !== undefined ? { archive: assetName(fields["archive"]) } : {}),
    ...(installOn !== undefined ? { installOn } : {}),
    ...(requiresSfall !== undefined ? { requiresSfall } : {}),
    ...(fields["state"] !== undefined
      ? { state: items(fields["state"], `"state"`).map((path, at) => modsPath(path, `"state" entry ${at + 1}`)) }
      : {}),
    refuse: fields["refuse"] === undefined ? [] : parseRefuse(fields["refuse"]),
    settings: fields["settings"] === undefined ? [] : parseSettings(fields["settings"], id),
  };
}
