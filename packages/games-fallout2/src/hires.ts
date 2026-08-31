/**
 * The High Resolution Patch: which version an install has.
 *
 * Reading only, unlike sfall. The patch is distributed from a forum thread rather than a release feed, so
 * there is nothing for ZAX to install or update it from - what it can do is say which version is there, which
 * is what a bug report needs and what tells the user whether `f2_res.ini` is being read by anything at all.
 */

import type { Install } from "@zax/core";
import type { Platform } from "@zax/platform";
import { installedLibraryVersion } from "./pe-version.js";

/** The patch is this library; `fallout2.exe` is patched to load it, and `f2_res.ini` is what configures it. */
const HIRES_LIBRARY = "f2_res.dll";

/** The installed version, or null when the install does not have the patch. */
export async function installedHiresVersion(platform: Platform, install: Install): Promise<string | null> {
  return installedLibraryVersion(platform, install, HIRES_LIBRARY);
}
