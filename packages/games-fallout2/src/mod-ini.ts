/**
 * A mod's ini files measured against the settings its manifest describes, and written from them - for authors
 * and their release CI (`pnpm mod-ini`, `actions/mod-ini`). The application never runs either: at install the
 * release's own file is what deploys, so a schema that drifted from it shows controls for keys the mod never
 * reads, and this is where that is caught.
 */

import { IniDocument, latin1Bytes, ownTarget, validate, type SettingKind } from "@zax/core";
import type { ModManifest, ModSetting } from "./manifest.js";

/** `soft` lets the file carry entries the manifest leaves out - a partial schema is valid; `hard` does not. */
export type IniMatch = "soft" | "hard";

export interface IniReport {
  /** Each mismatch, naming the file, the address and what disagrees. Empty is a match. */
  mismatches: readonly string[];
  /** Entries the files carry that no setting describes, which only `hard` counts against them. */
  undescribed: number;
  /** The files the settings name, in the order the manifest first names each. */
  files: readonly string[];
}

const fold = (text: string): string => text.toLowerCase();
const addressKey = (section: string, key: string): string => `${fold(section)}.${fold(key)}`;

function byFile(settings: readonly ModSetting[]): Map<string, ModSetting[]> {
  const out = new Map<string, ModSetting[]>();
  for (const setting of settings) {
    const file = ownTarget(setting).file;
    out.set(file, [...(out.get(file) ?? []), setting]);
  }
  return out;
}

/**
 * Whether the value a file ships is one the setting's control could hold. A bool is judged here rather than in
 * `validate`: an interface toggle can only write its own two spellings, so only a file can hold a third.
 */
function refusal(setting: ModSetting, value: string): string | undefined {
  const kind = setting.kind;
  if (kind.type === "bool")
    return value === kind.onValue || value === kind.offValue
      ? undefined
      : `Not its on value "${kind.onValue}" or its off value "${kind.offValue}"`;
  const verdict = validate(setting, value);
  return verdict.ok ? undefined : verdict.reason;
}

/**
 * Compares every file the settings name against what `read` returns for it, `undefined` meaning absent. Folded
 * as the engine folds names, so `[Main]` in the file answers for `main` in the manifest.
 */
export function checkModIni(
  manifest: ModManifest,
  read: (file: string) => Uint8Array | undefined,
  match: IniMatch,
): IniReport {
  const mismatches: string[] = [];
  // A setting this version dropped has no kind to judge a value by, and no file to look for it in. Reported
  // rather than skipped, since a check that passes over part of the schema is a check that passed nothing.
  for (const gone of manifest.dropped) mismatches.push(`"${gone.address}" cannot be checked: ${gone.why}`);
  const dropped = new Set(manifest.dropped.map((gone) => fold(gone.address)));

  const grouped = byFile(manifest.settings);
  let undescribed = 0;
  for (const [file, settings] of grouped) {
    const bytes = read(file);
    if (bytes === undefined) {
      mismatches.push(`${file}: absent, and the manifest describes ${settings.length} setting(s) in it`);
      continue;
    }
    const document = IniDocument.parseBytes(bytes);
    for (const setting of settings) {
      const { section, key } = ownTarget(setting);
      const at = `${file} [${section}] ${key}`;
      const value = document.get(section, key);
      if (value === undefined) {
        mismatches.push(`${at}: described by the manifest, absent from the file`);
        continue;
      }
      if (setting.default !== undefined && setting.default !== value)
        mismatches.push(`${at}: the file ships "${value}", the manifest's default is "${setting.default}"`);
      const wrong = refusal(setting, value);
      if (wrong !== undefined) mismatches.push(`${at}: the file ships "${value}" - ${wrong}`);
    }

    const described = new Set(
      settings.map((setting) => addressKey(ownTarget(setting).section, ownTarget(setting).key)),
    );
    const extra = document
      .entries()
      .filter(
        (entry) =>
          !described.has(addressKey(entry.section, entry.key)) && !dropped.has(addressKey(entry.section, entry.key)),
      );
    undescribed += extra.length;
    if (match === "soft") continue;
    for (const entry of extra)
      mismatches.push(`${file} [${entry.section}] ${entry.key}: in the file, not described by the manifest`);
    // A section with nothing in it names no key, so the pass above cannot see it - and hard means the headers
    // match too.
    const populated = new Set(document.entries().map((entry) => fold(entry.section)));
    for (const section of document.sections())
      if (!populated.has(fold(section)))
        mismatches.push(`${file} [${section}]: an empty section the manifest does not describe`);
  }
  return { mismatches, undescribed, files: [...grouped.keys()] };
}

/** The line saying which values a setting accepts, where its kind has more to say than its label does. */
function accepts(kind: SettingKind): string | undefined {
  switch (kind.type) {
    case "choice":
      return `One of: ${kind.options.map((option) => `${option.value} (${option.label})`).join(", ")}`;
    case "scale":
      return `0 to ${kind.max}`;
    case "int":
    case "float": {
      const unit = kind.unit ? ` ${kind.unit}` : "";
      const range =
        kind.min !== undefined && kind.max !== undefined
          ? `${kind.min} to ${kind.max}${unit}`
          : kind.min !== undefined
            ? `At least ${kind.min}${unit}`
            : kind.max !== undefined
              ? `At most ${kind.max}${unit}`
              : undefined;
      const sentinels = Object.entries(kind.sentinels ?? {}).map(([value, label]) => `${value} (${label})`);
      if (range === undefined) return sentinels.length ? `Also: ${sentinels.join(", ")}` : undefined;
      return sentinels.length ? `${range}, or ${sentinels.join(", ")}` : range;
    }
    case "bool":
    case "text":
    case "key":
      return undefined;
  }
}

/** Each non-empty text as `;` comment lines, a multi-line one a line apiece. */
const comments = (texts: readonly (string | undefined)[]): string[] =>
  texts
    .flatMap((text) => text?.split("\n") ?? [])
    .filter((line) => line.trim() !== "")
    .map((line) => `; ${line.trimEnd()}`);

/**
 * The lines unchanged, having checked each character has a latin1 byte. The game's files are bytes read as latin1
 * everywhere else, so these are written that way too - and a character with none would land as another silently.
 */
function inLatin1(owner: string, lines: readonly string[]): readonly string[] {
  for (const character of lines.join(""))
    if ((character.codePointAt(0) ?? 0) > 0xff)
      throw new Error(`${owner}: "${character}" has no latin1 byte, the encoding the game reads its ini in.`);
  return lines;
}

/**
 * Every file the settings name, written from the manifest alone: a section per `section` under its description,
 * and per setting its help (its label where it has none) and accepted values as comments above `key=default`.
 * Whatever a file held before is replaced, so
 * `existing` is read for its line terminator and nothing else - CRLF where there is no file, as the game's own
 * files have it.
 */
export function generateModIni(
  manifest: ModManifest,
  existing: (file: string) => Uint8Array | undefined,
): Map<string, Uint8Array> {
  if (manifest.dropped.length > 0)
    throw new Error(`Cannot write ${manifest.dropped.map((gone) => `"${gone.address}" (${gone.why})`).join(", ")}.`);
  if (manifest.settings.length === 0)
    throw new Error(`${manifest.id} describes no settings, so there is no ini to write.`);
  const valueless = manifest.settings.filter((setting) => setting.default === undefined);
  if (valueless.length > 0)
    throw new Error(
      `${valueless.map((setting) => setting.id).join(", ")}: no "default" stated, so there is no value to write.`,
    );

  const out = new Map<string, Uint8Array>();
  for (const [file, settings] of byFile(manifest.settings)) {
    const previous = existing(file);
    const eol = previous === undefined ? "\r\n" : IniDocument.parseBytes(previous).dominantEol;
    const sections = new Map<string, ModSetting[]>();
    for (const setting of settings) {
      const { section } = ownTarget(setting);
      sections.set(section, [...(sections.get(section) ?? []), setting]);
    }

    const lines: string[] = [];
    for (const [section, members] of sections) {
      if (lines.length > 0) lines.push("");
      const help = manifest.sectionHelp?.[section];
      lines.push(...inLatin1(`settings.sections.${section}`, [...comments([help]), `[${section}]`]));
      for (const [at, setting] of members.entries()) {
        if (at > 0) lines.push("");
        // The label mostly restates the key in words, so it stands in only where there is no help to write.
        const described = setting.help?.trim() ? setting.help : setting.label;
        const notes = comments([described, accepts(setting.kind)]);
        lines.push(...inLatin1(setting.id, [...notes, `${ownTarget(setting).key}=${setting.default ?? ""}`]));
      }
    }
    out.set(file, latin1Bytes(lines.map((line) => line + eol).join("")));
  }
  return out;
}
