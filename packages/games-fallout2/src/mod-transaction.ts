/**
 * The journal one mod install writes before it touches the game directory, and everything a retry or a
 * restore reads back out of it.
 *
 * Created once, at the start of the first attempt, and never rewritten: what it captures - the release being
 * installed, the record entry that install replaces, the load order as it stood - is true of the moment
 * before anything was written, and a second attempt that re-captured it would be capturing the first
 * attempt's wreckage. That is the whole reason this is a file rather than a set of values passed along:
 * `applyModInstall` runs again on a retry, and by then the directory no longer says what it used to.
 *
 * It lives in the working directory beside the downloaded archive and the copies deployment set aside, so
 * one directory holds the entire recovery and clearing it discards the transaction whole.
 */

import { temporaryDirectory, type Install } from "@zax/core";
import type { Platform } from "@zax/platform";
import { parseManifest } from "./manifest.js";
import type { ModRelease } from "./mod-feed.js";
import { installKey, type InstalledMod } from "./records.js";

/** Bumped when the meaning of a field changes; a journal this version cannot read is not resumed. */
const TRANSACTION_FORMAT = 3;

const JOURNAL = "transaction.json";

/** Where one payload came from, kept verbatim so a retry fetches what the first attempt did. */
interface PinnedAsset {
  name: string;
  url: string;
  digest: string;
}

export interface ModTransaction {
  id: string;
  /**
   * The release this transaction installs, pinned - its manifest verbatim, and where the payload is. A retry
   * resumes these rather than whatever the feed now calls newest: the copies waiting beside them were set
   * aside against this version, and an install that changed release mid-flight would leave a recovery that
   * no longer matches what is on disk.
   */
  archive?: PinnedAsset;
  /**
   * One pinned asset per chosen part, for a release that has them, and the selection that chose them. A retry
   * finishes the same parts from the same files: the copies waiting beside them are those parts', and asking
   * the interface again would let a second answer land on the first attempt's half-deployed directory.
   */
  parts?: Readonly<Record<string, PinnedAsset>>;
  selection?: readonly string[];
  manifestText: string;
  /**
   * The version this install resolved to, and whether the release published the manifest. Both are part of
   * the pin rather than re-derivable: a manifest read from the repository states no version, so the tag it
   * came from is the only thing that knows which release a retry is finishing.
   */
  version: string;
  manifestFromAsset: boolean;
  /** The record entry this install replaces, or null when it replaces nothing. The restore's target. */
  previous: InstalledMod | null;
  /** `mods_order.txt` exactly as it stood, or null when the install had none - the other half of that target. */
  order: string | null;
  /**
   * Which of the payload's paths were already on disk when the transaction opened. Recorded because after a
   * failed attempt the directory can no longer answer it: every path the attempt deployed looks occupied,
   * and a retry that read presence off the directory would set the half-installed file aside as if it were
   * the user's original.
   */
  preexisting: readonly string[];
}

/**
 * Where one transaction keeps everything: keyed by install and mod, and deliberately not by version. By
 * install, because the same release installed into two game directories is two transactions and sharing one
 * directory would let whichever finished first delete the other's recovery. Not by version, because a retry
 * has to find the directory the first attempt opened even if the feed has moved on since.
 */
export const modWorkDirectory = (platform: Platform, install: Install, id: string): string =>
  platform.paths.join(temporaryDirectory(platform), `mod-${installKey(install.path)}-${id}`);

export async function readTransaction(
  platform: Platform,
  install: Install,
  id: string,
): Promise<ModTransaction | null> {
  const at = platform.paths.join(modWorkDirectory(platform, install, id), JOURNAL);
  if ((await platform.fs.stat(at))?.kind !== "file") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(await platform.fs.read(at)));
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object") return null;
  const journal = raw as { transaction?: unknown } & Partial<ModTransaction>;
  // A journal written to a format this version does not know is not a journal it can resume from safely.
  if (journal.transaction !== TRANSACTION_FORMAT) return null;
  if (typeof journal.id !== "string" || typeof journal.manifestText !== "string") return null;
  if (typeof journal.version !== "string" || typeof journal.manifestFromAsset !== "boolean") return null;
  // One or the other: a parts release has no single payload, and a journal with neither pins nothing.
  if (journal.archive === undefined && journal.parts === undefined) return null;
  return {
    id: journal.id,
    ...(journal.archive !== undefined ? { archive: journal.archive } : {}),
    ...(journal.parts !== undefined ? { parts: journal.parts } : {}),
    ...(journal.selection !== undefined ? { selection: journal.selection } : {}),
    manifestText: journal.manifestText,
    version: journal.version,
    manifestFromAsset: journal.manifestFromAsset,
    previous: journal.previous ?? null,
    order: journal.order ?? null,
    preexisting: Array.isArray(journal.preexisting) ? journal.preexisting : [],
  };
}

export async function writeTransaction(
  platform: Platform,
  install: Install,
  transaction: ModTransaction,
): Promise<void> {
  const at = platform.paths.join(modWorkDirectory(platform, install, transaction.id), JOURNAL);
  const body = JSON.stringify({ transaction: TRANSACTION_FORMAT, ...transaction });
  await platform.fs.write(at, new TextEncoder().encode(body));
}

/**
 * The pinned release, as the feed would have answered it. What makes a retry install the version its
 * unfinished attempt started on, without asking the network which version that was.
 */
export function releaseOf(transaction: ModTransaction): ModRelease {
  return {
    manifest: parseManifest(new TextEncoder().encode(transaction.manifestText), {
      version: transaction.version,
      ...(transaction.archive ? { archive: transaction.archive.name } : {}),
    }),
    manifestText: transaction.manifestText,
    manifestFromAsset: transaction.manifestFromAsset,
    ...(transaction.archive ? { archive: transaction.archive } : {}),
    ...(transaction.parts ? { parts: transaction.parts } : {}),
  };
}
