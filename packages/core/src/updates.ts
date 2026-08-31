/**
 * Checking whether a newer ZAX has been released. The application does not update itself: it points the user at
 * the release, because replacing a running binary is the platform's business and getting it wrong leaves them
 * with neither version.
 */

import type { Platform } from "@zax/platform";
import { isRecord } from "./record.js";

const LATEST_RELEASE = "https://api.github.com/repos/BGforgeNet/zax/releases/latest";

export interface ZaxRelease {
  version: string;
  /** The build for the machine asking, or the release page when it publishes nothing that machine can run. */
  url: string;
}

export async function latestZax(platform: Platform): Promise<ZaxRelease> {
  const parsed: unknown = JSON.parse(await platform.net.fetchText(LATEST_RELEASE));
  const body = isRecord(parsed) ? parsed : {};
  const tag = body["tag_name"];
  const version = typeof tag === "string" ? tag.replace(/^v/i, "") : "";
  if (version === "") throw new Error("The release feed did not name a version.");

  const assets: unknown[] = Array.isArray(body["assets"]) ? body["assets"] : [];
  const named = assets.filter(
    (asset): asset is { name: string; browser_download_url: string } =>
      isRecord(asset) && typeof asset["name"] === "string" && typeof asset["browser_download_url"] === "string",
  );

  // These are the `os` macros and preferred portable targets in electron-builder.yml. Extension alone cannot
  // distinguish the Windows and macOS zips, and the release also carries an SBOM that no machine can run.
  const target =
    platform.arch === "other"
      ? undefined
      : {
          windows: { os: "win", extension: "exe" },
          linux: { os: "linux", extension: "appimage" },
          macos: { os: "mac", extension: "zip" },
        }[platform.os];
  const suffix = target && `-${target.os}-${platform.arch}.${target.extension}`;
  const match = suffix === undefined ? undefined : named.find((asset) => asset.name.toLowerCase().endsWith(suffix));
  const html = body["html_url"];
  const page = typeof html === "string" ? html : LATEST_RELEASE;
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
