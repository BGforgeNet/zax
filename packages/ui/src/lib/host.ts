/**
 * Which machine the interface is talking to.
 *
 * The desktop build installs a backend on the window object, backed by the real platform in another process.
 * Opened in a browser there is none, so the preview builds one over an in-memory platform seeded with the
 * bundled fixture: everything that only touches files works for real, and everything that reaches the network
 * or starts a program says it cannot. Recording a launch that never happened, or inventing a version number,
 * would be worse than refusing.
 */

import type { Platform } from "@zax/platform";
import { MemoryPlatform } from "@zax/platform/memory";
import { BACKEND_METHODS, createBackend, type Backend } from "@zax/fallout2";

import fallout2cfg from "../../../../fixtures/vanilla-f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/vanilla-f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/vanilla-f2up/ddraw.ini?raw";

declare global {
  interface Window {
    /** Installed by the desktop build's preload script. Absent in a browser. */
    zax?: Backend;
  }
}

export type HostKind = "desktop" | "preview";

/** The install the preview edits, named for what it is rather than as a plausible home directory. */
export const PREVIEW_INSTALL = "fixtures/vanilla-f2up";

export const PREVIEW_REASON = "The browser preview has no machine to reach - this needs the desktop build.";

function refuses(): never {
  throw new Error(PREVIEW_REASON);
}

/** The in-memory disk the preview edits. Exported so tests can reseed it between cases. */
export const previewPlatform: Platform = (() => {
  const memory = new MemoryPlatform({
    home: "preview",
    config: "preview/config",
    cache: "preview/cache",
    files: {
      [`${PREVIEW_INSTALL}/fallout2.cfg`]: fallout2cfg,
      [`${PREVIEW_INSTALL}/f2_res.ini`]: f2resini,
      [`${PREVIEW_INSTALL}/ddraw.ini`]: ddrawini,
      // The fixture directory holds config files only; these are what make it read as an install at all, and
      // they are the ones the install it came from has - a GOG game with killap's Unofficial Patch.
      [`${PREVIEW_INSTALL}/fallout2.exe`]: "",
      [`${PREVIEW_INSTALL}/up-changelog.txt`]: "",
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
})();

/**
 * Puts every argument through the same copy the desktop build's channel does, so an argument that could not
 * cross a process boundary fails here rather than only on the desktop. A function or a class instance is
 * refused outright; a reactive proxy is not, which is why the interface unwraps those before sending.
 *
 * Otherwise the cheap host would be laxer than the expensive one, which is the wrong way round.
 */
function copyingArguments(backend: Backend): Backend {
  const callable = backend as unknown as Record<string, (...args: unknown[]) => unknown>;
  const copied = Object.fromEntries(
    BACKEND_METHODS.map((name) => [name, (...args: unknown[]) => callable[name]!(...structuredClone(args))]),
  );
  // Built from the method list rather than declared, so its shape is the interface's by construction.
  return copied as unknown as Backend;
}

const supplied = typeof window === "undefined" ? undefined : window.zax;

export const hostKind: HostKind = supplied ? "desktop" : "preview";
// No picker in a browser, and a made-up path would name a folder nobody has.
export const backend: Backend = supplied ?? copyingArguments(createBackend(previewPlatform, { chooseFolder: refuses }));

/** True where an operation that leaves this page - a launch, a version check - cannot run. */
export const isPreview = hostKind === "preview";
