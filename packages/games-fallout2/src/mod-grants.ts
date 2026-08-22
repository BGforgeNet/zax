/**
 * Where a named mod may write outside `mods/`.
 *
 * Stacking mods are confined to `mods/`, and the exceptions are ZAX's to make rather than the manifest's to
 * claim: a mod declares the paths it writes, this list decides whether it may. Per mod rather than per path,
 * so a capability one mod needs is never handed to every mod, and it changes only with a ZAX release - the
 * same argument the feed list carries, since installing a mod is trusting its publisher and this is where
 * that trust is widened.
 *
 * A mod whose files can be packed into a `.dat` has no case here. EcCo's loose `data/` layout is packable and
 * was simply never packed, so repacking is its route in; a grant is for a mod with no such route, because the
 * engine reads its directory from the filesystem rather than through the archives.
 *
 * Two are known to need one and neither can be entered yet. HQ music writes `data/sound/music/`, which
 * `music_path1` names as a filesystem directory the engine reads, and Hero Appearance writes `appearance/`,
 * where sfall reads its sets as folders or dats. Neither publishes a manifest, so neither has an id, and the
 * id is the publisher's to declare - one guessed here would sit inert while the mod installed under another
 * name. Each goes in beside its `MOD_FEEDS` row when that row is added.
 */

export interface ModGrant {
  /** The mod's own id, as its manifest declares it - the same id a `MOD_FEEDS` row follows. */
  id: string;
  /** Directories it may write below, relative to the install, matched as the engine matches paths. */
  paths: readonly string[];
}

export const MOD_GRANTS: readonly ModGrant[] = [];

/** What this mod may write outside `mods/`. Nothing, for every mod the list does not name. */
export function grantsFor(id: string): readonly string[] {
  return MOD_GRANTS.find((grant) => grant.id === id)?.paths ?? [];
}
