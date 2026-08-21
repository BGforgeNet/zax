/**
 * What an archive is allowed to contain, judged from its directory before anything is extracted.
 *
 * Shared by every path that unpacks a downloaded archive over a game folder - a mod payload and an sfall
 * release alike. The two differ in where the archive comes from and in what integrity the publisher offers,
 * not in what an archive can do once 7-Zip is pointed at it: a symlink entry writes wherever it points, and a
 * declaration nobody read is how a few hundred kilobytes become a full disk. Extraction is too late to find
 * either out.
 */

import type { ArchiveEntryInfo, Platform } from "@zax/platform";

/** Ceilings, calibrated against the real corpus with headroom - RPU's gigabyte is the outlier. */
const MAX_ENTRIES = 10_000;
const MAX_PATH_DEPTH = 16;
const MAX_TOTAL_BYTES = 8 * 1024 ** 3;

/**
 * The archive's directory, once it has been judged. Returned rather than discarded because the caller needs
 * the same listing to plan from, and reading it twice would let the two disagree.
 *
 * `label` names the archive in every refusal, since the message reaches the user and "the archive" does not
 * say which one.
 */
export async function preflightArchive(
  platform: Platform,
  archive: string,
  label: string,
): Promise<readonly ArchiveEntryInfo[]> {
  const entries = await platform.archive.list(archive);
  if (entries.length > MAX_ENTRIES) throw new Error(`${label} declares ${entries.length} entries - refused.`);
  let total = 0;
  for (const entry of entries) {
    if (entry.kind === "link")
      throw new Error(`${label} contains a symbolic link (${entry.name}) - refused, nothing was extracted.`);
    if (entry.name.split("/").length > MAX_PATH_DEPTH)
      throw new Error(`${label} nests paths deeper than any release does (${entry.name}) - refused.`);
    total += entry.size;
  }
  if (total > MAX_TOTAL_BYTES)
    throw new Error(`${label} declares ${total} bytes unpacked, past what any release needs - refused.`);
  return entries;
}
