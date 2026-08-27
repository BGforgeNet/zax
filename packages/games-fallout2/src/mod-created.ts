/**
 * Where the install a base mod creates actually is, and why a release is never laid over one.
 *
 * An installation that already reports what the mod creates IS that install: a Fallout et tu folder added to
 * the list is the same game as the `Fallout1in2/` folder inside its host, seen from the other side. Reading it
 * as a host with no install in it is what would offer to build a second copy of the game inside the first.
 *
 * A leaf on purpose: the feed decides what a row says and the install decides what it writes, and the two have
 * to agree about which directory the mod is in and about what the answer is when one is there already.
 */

import type { GameType } from "@zax/core";
import type { Paths } from "@zax/platform";
import type { ModManifest } from "./manifest.js";

/**
 * Whether this mod's install is the installation itself rather than a folder of it. Keyed on the type the
 * directory reports, which is how a hand-installed one answers too - and most are, since upstream's own route
 * is a zip the user unpacks.
 *
 * `creates` is read for presence alone, so a caller holding the directory name answers as well as a manifest.
 */
export const createsInPlace = (type: GameType, mod: { becomes?: GameType; creates?: unknown }): boolean =>
  mod.creates !== undefined && mod.becomes === type;

/** The install this mod's release belongs to, inside the installation it is offered on. */
export const createdInstallPath = (
  paths: Paths,
  install: { path: string; type: GameType },
  mod: { becomes?: GameType; creates: { directory: string } },
): string => (createsInPlace(install.type, mod) ? install.path : paths.join(install.path, mod.creates.directory));

/**
 * Why an install this mod made takes no release over it.
 *
 * One sentence, here rather than at either site: the row that declines to offer the release and the install
 * that refuses to perform it are the same refusal, and two wordings would let a user read one and then be told
 * the other. Its subject is what differs - a folder inside this installation, or this installation itself -
 * and naming the wrong one sends the user looking for a folder they do not have.
 */
export function noUpgradeHere(manifest: ModManifest, install: { type: GameType }): string {
  const what = createsInPlace(install.type, manifest)
    ? `This installation is ${manifest.name}`
    : `${manifest.creates?.directory} holds ${manifest.name}`;
  return `${what} already, and it publishes no way to update one - only an unpack into a folder that has none. ${manifest.version} would have to go into a fresh folder.`;
}
