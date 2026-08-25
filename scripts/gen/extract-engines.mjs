/**
 * Reads an alternative engine's own source for the settings it registers, and writes what it found to
 * `engines/<id>.json` beside this file.
 *
 * Run by hand against a checkout, not by CI, which has no network:
 *   node scripts/gen/extract-engines.mjs fallout2-ce <path to a fallout2-ce checkout>
 *   node scripts/gen/extract-engines.mjs fission <path to a fission-ce checkout>
 *
 * The output is committed, so regeneration is a comparison against a recorded reading rather than a fresh
 * fetch - the same reason `layout.json` is committed. The commit the reading came from is recorded in it,
 * because the engine ZAX describes has to be a build a user could actually be running, and one of these
 * projects republishes a single tag in place.
 *
 * Every fact here is read off the source that defines it. Nothing is inferred from a key's name.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [id, checkout] = process.argv.slice(2);
if (!id || !checkout) {
  console.error("usage: node scripts/gen/extract-engines.mjs <fallout2-ce|fission> <checkout path>");
  process.exit(2);
}

const read = (relative) => fs.readFileSync(path.join(checkout, relative), "utf8");

/** The commit the reading came from. A pin is only worth having if it names something exact. */
const commitOf = () =>
  // Bounded: a checkout that is not a git repository must fail here rather than pin nothing.
  execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 30_000 }).trim();

/**
 * Field types, per struct, out of the settings header. The struct a section reads into is what says whether a
 * key is a switch, a number or a path - the config file itself holds only text.
 */
function fieldTypes(header) {
  const out = new Map();
  let struct = null;
  for (const line of header.split("\n")) {
    const opened = /^struct\s+(\w+)\s*\{/.exec(line);
    if (opened) {
      struct = opened[1];
      out.set(struct, new Map());
      continue;
    }
    if (/^\};/.test(line)) {
      struct = null;
      continue;
    }
    if (struct === null) continue;
    // Any type, not a list of the ones seen so far: two fields are enums, and a type this does not
    // recognize has to reach the caller as itself rather than be skipped into silence.
    const field = /^\s+([\w:]+)\s+(\w+)\s*(=|;)/.exec(line);
    if (field && field[2] !== "const") out.get(struct).set(field[2], field[1]);
  }
  return out;
}

/**
 * Which struct each member of the top-level `Settings` holds. Read rather than derived from the member's
 * name: one of these projects calls its `graphics` member's type `GraphicSettings`, and a rule that guessed
 * the name would be right eight times and silently wrong once.
 */
function memberStructs(header) {
  const out = new Map();
  const block = /^struct Settings \{$([\s\S]*?)^\};$/m.exec(header);
  if (block === null) throw new Error("the settings header declares no Settings struct");
  for (const line of (block[1] ?? "").split("\n")) {
    const member = /^\s+(\w+)\s+(\w+);/.exec(line);
    if (member) out.set(member[2], member[1]);
  }
  return out;
}

/**
 * `bool` is a switch, `std::string` is text, a floating-point field is `real`, and everything else - the two
 * enums included - is a whole number, since an enum is written to an ini as its integer. Whole and real are
 * kept apart because a control over one is not a control over the other.
 */
const kindOf = (type) =>
  type === "bool"
    ? "bool"
    : type === "std::string"
      ? "text"
      : type === "float" || type === "double"
        ? "real"
        : "number";

/**
 * fallout2-ce registers its settings through macros inside `#define SECT <section>` blocks, so the section,
 * the key and the struct field all come off one line. `SETTING_P(key, clamp(a, b))` is where its real bounds
 * live: the engine clamps on load, so a value outside them is not one the engine will keep.
 */
function readCommunityEdition() {
  const source = read("src/settings.cc");
  const header = read("src/settings.h");
  const types = fieldTypes(header);
  const members = memberStructs(header);
  // A section's macro block names the member of `Settings` it reads into, which names the struct.
  const structFor = (section) => types.get(members.get(section) ?? "");

  const out = [];
  let section = null;
  for (const line of source.split("\n")) {
    const opened = /^#define SECT (\w+)/.exec(line);
    if (opened) {
      section = opened[1];
      continue;
    }
    if (/^#undef SECT/.test(line)) {
      section = null;
      continue;
    }
    if (section === null) continue;

    const plain = /^\s+SETTING\((\w+)\);/.exec(line);
    const processed = /^\s+SETTING_P\((\w+),\s*(.+)\);\s*$/.exec(line);
    const asPath = /^\s+SETTING_PATH\((\w+)\);/.exec(line);
    const key = plain?.[1] ?? processed?.[1] ?? asPath?.[1];
    if (key === undefined) continue;

    // SETTING_PATH stores into `<key>_path`; the other two into the key's own name.
    const field = asPath ? `${key}_path` : key;
    const type = structFor(section)?.get(field);
    if (type === undefined) throw new Error(`${section}.${key}: no field "${field}" in the settings header`);

    // The engine clamps on load, so these are the values it will actually keep. Two of them are stated as
    // enum members rather than numbers; those are carried across as written, for the generator to resolve
    // against the enum, rather than dropped into a setting that looks unbounded.
    const bounds = processed ? /^clamp\((.+),\s*(.+)\)$/.exec(processed[2] ?? "") : null;
    const numeric = bounds !== null && /^-?[\d.]+$/.test(bounds[1] ?? "") && /^-?[\d.]+$/.test(bounds[2] ?? "");
    out.push({
      section,
      key,
      kind: asPath ? "path" : kindOf(type),
      ...(numeric ? { min: Number(bounds[1]), max: Number(bounds[2]) } : {}),
      ...(bounds !== null && !numeric ? { clamp: `${bounds[1]}, ${bounds[2]}` } : {}),
    });
  }
  return out;
}

/**
 * The example config fallout2-ce ships carries a comment above most of its own keys, which is the only prose
 * the project writes about them. Taken as the help text, one paragraph per key, and left out where there is
 * none rather than invented.
 */
function communityEditionNotes() {
  const out = new Map();
  let section = null;
  let comment = [];
  for (const raw of read("files/fallout2.cfg").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      comment = [];
      continue;
    }
    const opened = /^\[(\w+)\]$/.exec(line);
    if (opened) {
      section = opened[1];
      comment = [];
      continue;
    }
    if (line.startsWith(";")) {
      comment.push(line.slice(1).trim());
      continue;
    }
    const pair = /^([\w#]+)=(.*)$/.exec(line);
    if (pair && section !== null) {
      out.set(`${section}.${pair[1]}`, { default: pair[2], ...(comment.length ? { help: comment.join(" ") } : {}) });
    }
    comment = [];
  }
  return out;
}

/**
 * Fission reads each setting by a pair of `GAME_CONFIG_*` constants rather than through a macro, so the
 * section and key are resolved through the header that defines them.
 */
function readFission() {
  const constants = new Map();
  for (const line of read("src/game_config.h").split("\n")) {
    const defined = /^#define (GAME_CONFIG_\w+)\s+"([^"]*)"/.exec(line);
    if (defined) constants.set(defined[1], defined[2]);
  }
  const header = read("src/settings.h");
  const types = fieldTypes(header);
  const members = memberStructs(header);

  const out = [];
  for (const line of read("src/settings.cc").split("\n")) {
    const call = /settingsRead\((GAME_CONFIG_\w+),\s*(GAME_CONFIG_\w+),\s*settings\.(\w+)\.(\w+)\)/.exec(line);
    if (!call) continue;
    const section = constants.get(call[1]);
    const key = constants.get(call[2]);
    if (section === undefined || key === undefined) throw new Error(`${call[1]}/${call[2]}: no such constant`);
    const type = types.get(members.get(call[3]) ?? "")?.get(call[4]);
    if (type === undefined) throw new Error(`${section}.${key}: no field "${call[4]}" in the settings header`);
    out.push({ section, key, kind: (call[4] ?? "").endsWith("_path") ? "path" : kindOf(type) });
  }
  return out;
}

const READERS = {
  "fallout2-ce": () => {
    const notes = communityEditionNotes();
    return readCommunityEdition().map((one) => ({ ...one, ...(notes.get(`${one.section}.${one.key}`) ?? {}) }));
  },
  fission: readFission,
};

if (!(id in READERS)) throw new Error(`"${id}" is not an engine this reads`);
const keys = READERS[id]();
// The mapper is a separate program with its own window; nothing ZAX shows is about it.
const kept = keys.filter((one) => one.section !== "mapper");

const at = `scripts/gen/engines/${id}.json`;
fs.mkdirSync("scripts/gen/engines", { recursive: true });
fs.writeFileSync(at, `${JSON.stringify({ engine: id, commit: commitOf(), keys: kept }, null, 2)}\n`);

const bySection = {};
for (const one of kept) bySection[one.section] = (bySection[one.section] ?? 0) + 1;
console.log(`${at}: ${kept.length} keys (${keys.length - kept.length} skipped as the mapper's)`);
console.log(bySection);
