/**
 * What ZAX installed into each game directory, kept in ZAX's own data. One UTF-8 YAML file per install,
 * beside `zax.yml` rather than under the cache: the cache is what users and ZAX's own wipe buttons feel free
 * to clear, and clearing caches must not erase the knowledge of what is installed where.
 *
 * The record only adds what the directory cannot say - version, provenance, deployed files, the manifest and
 * state files as the release shipped them. Presence still comes from reading the directory on every load, so
 * losing the records degrades to today's situation: mods are seen but unversioned.
 */

import { parse, stringify } from "yaml";
import { fnv1a } from "@zax/core";
import type { Platform } from "@zax/platform";
import { insideMods, isModId, isModVersion, parseManifest } from "./manifest.js";

/** Bumped when the meaning of a field changes - the same rule the manifest's `spec` carries. */
const RECORD_FORMAT = 1;

export interface InstalledMod {
  /** Bound to the manifest's own id shape: it names a working directory, and a record is a file on disk. */
  id: string;
  version: string;
  /**
   * The manifest's type as it was validated at install time, and the reason a permanent one gives. Held as
   * its own field rather than read back out of the manifest snapshot below, so a removal is judged against
   * something this version parsed rather than against a document a newer ZAX may have written.
   */
  type?: "pluggable" | "permanent";
  reason?: string;
  /** False from the first byte deployed until the install finished, so a relaunch offers retry or restore. */
  complete: boolean;
  /** Deployed paths relative to the install, every one under `mods/` - what uninstall deletes. */
  files: readonly string[];
  /** The manifest exactly as the release carried it: schema and state list readable without the network. */
  manifest: string;
  /** State files as that release shipped them, latin1 text - the base an upgrade's merge compares against. */
  shipped: Readonly<Record<string, string>>;
}

/**
 * What to call a recorded mod. The manifest snapshot carries the name the author gave it; an id is what is
 * left when that snapshot will not parse, which is the same fallback the availability list makes.
 */
export function modName(mod: InstalledMod): string {
  try {
    return parseManifest(new TextEncoder().encode(mod.manifest), { version: mod.version }).name;
  } catch {
    return mod.id;
  }
}

export interface InstallRecord {
  /** The install directory, in clear - the filename is its hash, which nothing can read back. */
  path: string;
  mods: readonly InstalledMod[];
}

const recordsDirectory = (platform: Platform): string => platform.paths.join(platform.paths.config, "installed-mods");

/** Trailing separators dropped, so two spellings of one directory land on one record file. */
const normalizePath = (path: string): string => path.replace(/[\\/]+$/, "");

/**
 * One install directory as a short path-safe name. The name carries nothing but uniqueness - the path in
 * clear inside the record is the truth - so a small non-cryptographic hash serves. Exported because a
 * transaction's working directory is keyed by install too, and two spellings of that key would put one
 * install's recovery files where another's are looked for.
 */
export const installKey = (installPath: string): string => fnv1a(normalizePath(installPath));

function recordPath(platform: Platform, installPath: string): string {
  return platform.paths.join(recordsDirectory(platform), `${installKey(installPath)}.yml`);
}

const asText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/**
 * One recorded mod, or null when the entry cannot be trusted. Entries are judged one at a time rather than
 * the file whole - a hand-edited or damaged entry costs itself, not every other mod's record - and a file
 * list reaching outside `mods/` drops the entry, so a tampered record degrades to hand-installed instead of
 * aiming uninstall somewhere new.
 */
function readMod(entry: unknown): InstalledMod | null {
  if (entry === null || typeof entry !== "object") return null;
  const fields = entry as Record<string, unknown>;
  const id = asText(fields["id"]);
  const version = asText(fields["version"]);
  const manifest = asText(fields["manifest"]);
  if (id === undefined || version === undefined || manifest === undefined) return null;
  // Both name a directory under the cache once a transaction opens, so they pass the manifest's own shapes
  // before they are believed - a hand-edited record is the one route into these fields that skipped them.
  if (!isModId(id) || !isModVersion(version)) return null;

  const declared = asText(fields["type"]);
  const type = declared === "pluggable" || declared === "permanent" ? declared : undefined;
  const reason = asText(fields["reason"]);

  const files: string[] = [];
  for (const file of Array.isArray(fields["files"]) ? fields["files"] : []) {
    const path = asText(file);
    if (path === undefined || !insideMods(path)) return null;
    files.push(path);
  }

  const shipped: Record<string, string> = {};
  const rawShipped = fields["shipped"];
  if (rawShipped !== null && typeof rawShipped === "object" && !Array.isArray(rawShipped)) {
    for (const [path, content] of Object.entries(rawShipped as Record<string, unknown>)) {
      const text = asText(content);
      if (text === undefined || !insideMods(path)) return null;
      shipped[path] = text;
    }
  }

  return {
    id,
    version,
    ...(type !== undefined ? { type } : {}),
    ...(reason !== undefined ? { reason } : {}),
    complete: fields["complete"] === true,
    files,
    manifest,
    shipped,
  };
}

/** The record for an install, or the empty one - a first install and a lost record read the same. */
export async function loadRecord(platform: Platform, installPath: string): Promise<InstallRecord> {
  const path = normalizePath(installPath);
  const at = recordPath(platform, path);
  if ((await platform.fs.stat(at))?.kind !== "file") return { path, mods: [] };

  let raw: unknown;
  try {
    raw = parse(new TextDecoder().decode(await platform.fs.read(at)));
  } catch {
    // A record that will not parse is a lost record, which every flow already tolerates - not a crash.
    return { path, mods: [] };
  }
  if (raw === null || typeof raw !== "object") return { path, mods: [] };
  const fields = raw as Record<string, unknown>;
  const mods = (Array.isArray(fields["mods"]) ? fields["mods"] : [])
    .map(readMod)
    .filter((mod): mod is InstalledMod => mod !== null);
  return { path, mods };
}

/** Writes the record back, or removes the file when the last mod is gone - an empty record is no record. */
export async function saveRecord(platform: Platform, record: InstallRecord): Promise<void> {
  const path = normalizePath(record.path);
  const at = recordPath(platform, path);
  if (record.mods.length === 0) return platform.fs.remove(at);
  const body = stringify(
    {
      record: RECORD_FORMAT,
      path,
      mods: record.mods.map((mod) => ({
        id: mod.id,
        version: mod.version,
        ...(mod.type !== undefined ? { type: mod.type } : {}),
        ...(mod.reason !== undefined ? { reason: mod.reason } : {}),
        complete: mod.complete,
        files: [...mod.files],
        manifest: mod.manifest,
        shipped: { ...mod.shipped },
      })),
    },
    // Unwrapped for the same reason zax.yml is: folded long scalars are lossless but unreadable to hand-edit.
    { lineWidth: 0 },
  );
  await platform.fs.write(at, new TextEncoder().encode(body));
}

/**
 * Reconciles a record against the directory it describes. A mod whose recorded files are all gone was
 * removed behind ZAX's back and is dropped - the two cannot drift far - while a directory that cannot be
 * read at all sets the record aside untouched, the same tolerance the install list extends to the install.
 * The pruned record is saved when anything changed, so the drop happens once rather than on every load.
 */
export async function reconcileRecord(platform: Platform, record: InstallRecord): Promise<InstallRecord> {
  if ((await platform.fs.stat(record.path))?.kind !== "dir") return record;

  const kept: InstalledMod[] = [];
  for (const mod of record.mods) {
    let present = mod.files.length === 0;
    for (const file of mod.files) {
      const at = platform.paths.join(record.path, ...file.split("/"));
      if ((await platform.fs.stat(at))?.kind === "file") {
        present = true;
        break;
      }
    }
    if (present) kept.push(mod);
  }
  if (kept.length === record.mods.length) return record;
  const pruned: InstallRecord = { path: record.path, mods: kept };
  await saveRecord(platform, pruned);
  return pruned;
}
