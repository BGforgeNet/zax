/**
 * What an archive is allowed to contain, judged from its directory before anything is extracted.
 *
 * Shared by every path that unpacks a downloaded archive over a game folder - a mod payload and an sfall
 * release alike. The two differ in where the archive comes from and in what integrity the publisher offers,
 * not in what an archive can do once 7-Zip is pointed at it: a symlink entry writes wherever it points, an
 * entry named ".." writes above the folder it was aimed at, and a declaration nobody read is how a few hundred
 * kilobytes become a full disk. Extraction is too late to find any of them out.
 */

import type { ArchiveEntryInfo, Platform } from "@zax/platform";

/**
 * Ceilings, measured against the published corpus. Everything ZAX installs declares under 100 entries and a
 * gigabyte except Fallout et tu, which ships Fallout 1's asset tree unpacked rather than in a `.dat`: 10,985
 * entries at v1.16.3771, up from 9,591 at v1.8, which is why this ceiling sits so far above the rest.
 */
const MAX_ENTRIES = 65_536;
const MAX_PATH_DEPTH = 16;
const MAX_TOTAL_BYTES = 8 * 1024 ** 3;

/**
 * Whether an entry names somewhere other than inside the folder it is unpacked into - an absolute path, a
 * drive or share root, or a climb through "..".
 *
 * 7-Zip declines these itself, but that is its behaviour rather than a guarantee this code holds, and the
 * extraction here is one implementation of the platform seam among others. Judged on the name as declared,
 * splitting on either separator, since a Windows archive writes the other one.
 */
function escapesDirectory(name: string): boolean {
  if (/^[/\\]/.test(name) || /^[A-Za-z]:/.test(name)) return true;
  return name.split(/[/\\]/).includes("..");
}

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
      throw new Error(
        `${label} contains a symbolic link or hard link (${entry.name}) - refused, nothing was extracted.`,
      );
    if (escapesDirectory(entry.name))
      throw new Error(`${label} names a path outside the folder it unpacks into (${entry.name}) - refused.`);
    if (entry.name.split(/[/\\]/).length > MAX_PATH_DEPTH)
      throw new Error(`${label} nests paths deeper than any release does (${entry.name}) - refused.`);
    total += entry.size;
  }
  if (total > MAX_TOTAL_BYTES)
    throw new Error(`${label} declares ${total} bytes unpacked, past what any release needs - refused.`);
  return entries;
}
