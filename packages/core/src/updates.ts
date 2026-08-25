/**
 * Checking whether a newer ZAX has been released. The application does not update itself: it points the user at
 * the release, because replacing a running binary is the platform's business and getting it wrong leaves them
 * with neither version.
 */

import type { Platform } from "@zax/platform";

const LATEST_RELEASE = "https://api.github.com/repos/BGforgeNet/zax/releases/latest";

export interface ZaxRelease {
  version: string;
  /** The build for the machine asking, or the release page when it publishes nothing that machine can run. */
  url: string;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

export async function latestZax(platform: Platform): Promise<ZaxRelease> {
  const body = JSON.parse(await platform.net.fetchText(LATEST_RELEASE)) as GithubRelease;
  const version = typeof body.tag_name === "string" ? body.tag_name.replace(/^v/i, "") : "";
  if (version === "") throw new Error("The release feed did not name a version.");

  const assets = Array.isArray(body.assets) ? body.assets : [];
  const named = assets.filter(
    (asset): asset is { name: string; browser_download_url: string } =>
      typeof (asset as { name?: unknown }).name === "string" &&
      typeof (asset as { browser_download_url?: unknown }).browser_download_url === "string",
  );

  // One build per platform, told apart by extension: the Windows one is an .exe and the other is not.
  const windows = platform.os === "windows";
  const match = named.find((asset) => asset.name.toLowerCase().endsWith(".exe") === windows);
  const page = typeof body.html_url === "string" ? body.html_url : LATEST_RELEASE;
  return { version, url: httpsOnly(match?.browser_download_url) ?? httpsOnly(page) ?? LATEST_RELEASE };
}

/**
 * The address if it is one this may be opened with, and undefined otherwise.
 *
 * Checked here rather than where it is opened: this is where the feed's bytes become a value, and the thing
 * that receives it is the system's own opener, which will do whatever the scheme says - `file:` reaches the
 * disk, and the shells that handle the rest are not ours.
 */
function httpsOnly(address: string | undefined): string | undefined {
  if (address === undefined) return undefined;
  try {
    return new URL(address).protocol === "https:" ? address : undefined;
  } catch {
    return undefined;
  }
}
