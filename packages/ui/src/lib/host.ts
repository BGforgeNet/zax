/**
 * Which machine the interface is talking to.
 *
 * The desktop build hands the real platform in on the window object. Opened in a browser there is no such
 * thing, so the preview runs against an in-memory one seeded with the bundled fixture: everything that only
 * touches files works for real, and everything that reaches the network or starts a program says it cannot.
 * Recording a launch that never happened, or inventing a version number, would be worse than refusing.
 */

import type { Platform } from "@zax/platform";
import { MemoryPlatform } from "@zax/platform/memory";

import fallout2cfg from "../../../../fixtures/vanilla-f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/vanilla-f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/vanilla-f2up/ddraw.ini?raw";

declare global {
  interface Window {
    /** Installed by the desktop build's preload script. Absent in a browser. */
    zaxPlatform?: Platform;
  }
}

export type HostKind = "desktop" | "preview";

/** The install the preview edits, named for what it is rather than as a plausible home directory. */
export const PREVIEW_INSTALL = "fixtures/vanilla-f2up";

export const PREVIEW_REASON = "The browser preview has no machine to reach - this needs the desktop build.";

function refuses(): never {
  throw new Error(PREVIEW_REASON);
}

function previewPlatform(): Platform {
  const memory = new MemoryPlatform({
    home: "preview",
    config: "preview/config",
    cache: "preview/cache",
    files: {
      [`${PREVIEW_INSTALL}/fallout2.cfg`]: fallout2cfg,
      [`${PREVIEW_INSTALL}/f2_res.ini`]: f2resini,
      [`${PREVIEW_INSTALL}/ddraw.ini`]: ddrawini,
      // The fixture directory holds config files only; these are what make it read as an install at all.
      [`${PREVIEW_INSTALL}/fallout2.exe`]: "",
      [`${PREVIEW_INSTALL}/mods/upu.dat`]: "",
      "preview/config/zax.yml": `games:\n- path: ${PREVIEW_INSTALL}\ntheme: system\n`,
    },
  });

  return {
    os: memory.os,
    fs: memory.fs,
    paths: memory.paths,
    archive: memory.archive,
    // Nothing here can be simulated honestly: a recorded launch and an invented release both read as success.
    process: { launch: refuses, open: refuses },
    net: { fetchText: refuses, download: refuses },
  };
}

const supplied = typeof window === "undefined" ? undefined : window.zaxPlatform;

export const hostKind: HostKind = supplied ? "desktop" : "preview";
export const platform: Platform = supplied ?? previewPlatform();

/** True where an operation that leaves this page - a launch, a version check - cannot run. */
export const isPreview = hostKind === "preview";
