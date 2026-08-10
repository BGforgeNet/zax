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
import { createBackend, wrapMethods, type Backend, type OperationProgress } from "@zax/fallout2";

import fallout2cfg from "../../../../fixtures/vanilla-f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/vanilla-f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/vanilla-f2up/ddraw.ini?raw";

/** How the interface hears about a long operation's progress, whichever host it is talking to. */
export interface ProgressSource {
  subscribe(listener: (progress: OperationProgress) => void): void;
}

declare global {
  interface Window {
    /** Installed by the desktop build's preload script. Absent in a browser. */
    zax?: Backend;
    /** Its companion, carrying the one thing that travels the other way. */
    zaxProgress?: ProgressSource;
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
      /*
        A mods folder covering every state the mods view has: one loaded, one commented out, one folder rather
        than an archive, an entry whose file is gone, and one sitting in the folder that the order file never
        names. None of these names is a marker `detectGameType` reads, or seeding them would relabel the
        preview install as a different game.
      */
      [`${PREVIEW_INSTALL}/mods/mods_order.txt`]:
        "; Loaded in this order - a mod further down overrides one above it.\n" +
        "weapon_sounds.dat\n; extra_music.dat\nhero_appearance\nold_patch.dat\n",
      [`${PREVIEW_INSTALL}/mods/weapon_sounds.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/extra_music.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/barter_prices.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/hero_appearance/art/critters/hmjmps.frm`]: "",
      "preview/config/zax.yml": `games:\n- path: ${PREVIEW_INSTALL}\ntheme: system\n`,
    },
  });

  return {
    os: memory.os,
    fs: memory.fs,
    paths: memory.paths,
    archive: memory.archive,
    // Answers nothing, which is the truth rather than a refusal: a browser has no registry, and "no such key"
    // is what a scan does with every machine that has none of these launchers.
    registry: memory.registry,
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
  return wrapMethods(
    backend,
    (call) =>
      (...args: unknown[]) =>
        call(...structuredClone(args)),
  );
}

const supplied = typeof window === "undefined" ? undefined : window.zax;

export const hostKind: HostKind = supplied ? "desktop" : "preview";

/**
 * The preview's own progress, built here rather than refused: the backend it runs is in this process, so it
 * can report exactly as the desktop's does. Which means the interface's progress display is exercised by the
 * preview and by its tests, instead of only existing on the build that is hardest to drive.
 */
const previewListeners: Array<(progress: OperationProgress) => void> = [];

// No picker in a browser, and a made-up path would name a folder nobody has.
export const backend: Backend =
  supplied ??
  copyingArguments(
    createBackend(previewPlatform, {
      chooseFolder: refuses,
      report: (progress) => previewListeners.forEach((listener) => listener(progress)),
    }),
  );

// Guarded the same way `supplied` is: this module is loaded by tests that run with no window at all.
export const progressSource: ProgressSource = (typeof window === "undefined" ? undefined : window.zaxProgress) ?? {
  subscribe: (listener) => previewListeners.push(listener),
};

/** True where an operation that leaves this page - a launch, a version check - cannot run. */
export const isPreview = hostKind === "preview";
