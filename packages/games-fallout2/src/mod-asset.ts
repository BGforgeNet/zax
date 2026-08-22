/**
 * Fetching one file a release names, verified against the digest that release states.
 *
 * Its own module because three different things arrive this way - a mod's payload, a base mod's installer,
 * and the tool ZAX unpacks a Fallout archive with - and a second copy of these four steps would be a second
 * place for the digest check to go missing from.
 */

import type { DownloadOptions, Platform } from "@zax/platform";
import type { ReleaseAsset } from "./mod-feed.js";

export interface ModProgress extends DownloadOptions {
  onStep?: (step: string) => void;
}

/**
 * One asset in a working directory, verified. A verified copy already there is kept, which is what makes a
 * retry resume instead of paying the download again.
 */
export async function fetchAsset(
  platform: Platform,
  work: string,
  asset: ReleaseAsset,
  what: { mod: string; label: string },
  options?: ModProgress,
): Promise<string> {
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? "")?.[1]?.toLowerCase();
  // Required rather than best-effort: the digest is what closes in-transit tampering, truncation and a
  // corrupted resume in one check, and the feeds this list trusts all publish one.
  if (!digest) throw new Error(`The ${what.mod} release states no digest for ${asset.name}.`);

  const archivePath = platform.paths.join(work, asset.name);
  const present = (await platform.fs.stat(archivePath))?.kind === "file";
  if (present && (await platform.hash.sha256(archivePath)) === digest) return archivePath;

  options?.onStep?.(`Downloading ${what.label}`);
  await platform.net.download(asset.url, archivePath, options);
  if ((await platform.hash.sha256(archivePath)) !== digest) {
    await platform.fs.remove(archivePath);
    throw new Error(
      `What arrived for ${asset.name} does not match the digest its release states - the download may have been tampered with or corrupted. Nothing was installed.`,
    );
  }
  return archivePath;
}
