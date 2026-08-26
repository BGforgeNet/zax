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
import { createBackend, saveRecord, wrapMethods, type Backend, type OperationProgress } from "@zax/fallout2";

import fallout2cfg from "../../../../fixtures/f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/f2up/ddraw.ini?raw";
// FO2tweaks as it publishes itself: the manifest its repository carries and the ini its release ships, both
// verbatim. A sample written here would drift from the format the mod actually uses, and this surface only
// means anything if it is the real one.
import fo2tweaksManifest from "../../../../fixtures/fo2tweaks/f2mod.yml?raw";
import fo2tweaksIni from "../../../../fixtures/fo2tweaks/mods/fo2tweaks.ini?raw";

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
export const PREVIEW_INSTALL = "fixtures/f2up";

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
        than an archive, an entry whose file is gone, one sitting in the folder that the order file never
        names, and one the record below claims - the only kind that shows an owner. Two entries are gone
        rather than one, which is the state the bulk forget is offered in; the last two are the two the
        shipped recommendation ranks, seeded the wrong way round, which is what the load-order advice has to
        say something about. None of these names is a marker `detectGameType` reads, or seeding them would
        relabel the preview install as a different game.
      */
      [`${PREVIEW_INSTALL}/mods/mods_order.txt`]:
        "; Loaded in this order - a mod further down overrides one above it.\n" +
        "weapon_sounds.dat\n; extra_music.dat\nhero_appearance\nold_patch.dat\nold_music.dat\n" +
        "InventoryFilter.dat\nfo2tweaks.dat\n",
      [`${PREVIEW_INSTALL}/mods/InventoryFilter.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/fo2tweaks.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/weapon_sounds.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/extra_music.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/barter_prices.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/hero_appearance/art/critters/hmjmps.frm`]: "",
      [`${PREVIEW_INSTALL}/mods/fo2tweaks.ini`]: fo2tweaksIni,
      "preview/config/zax.yml": `games:\n- path: ${PREVIEW_INSTALL}\ntheme: system\n`,
    },
  });

  return {
    os: memory.os,
    arch: memory.arch,
    fs: memory.fs,
    paths: memory.paths,
    archive: memory.archive,
    hash: memory.hash,
    // Answers nothing, which is the truth rather than a refusal: a browser has no registry, and "no such key"
    // is what a scan does with every machine that has none of these launchers.
    registry: memory.registry,
    // Nothing here can be simulated honestly: a recorded launch and an invented release both read as success.
    process: { launch: refuses, run: refuses, open: refuses, runWasm: refuses },
    net: { fetchText: refuses, download: refuses },
  };
})();

// The record is what makes the seeded ini an installed mod rather than clutter. Written through the real
// writer so the preview holds a record the desktop build could have made, and awaited so nothing can read
// the preview before it exists.
await saveRecord(previewPlatform, {
  path: PREVIEW_INSTALL,
  mods: [
    {
      id: "fo2tweaks",
      // The release the fixture was taken from. The manifest states no version of its own - a committed one
      // takes it from the release tag - so refreshing the fixture means moving this with it.
      version: "14.7",
      // What an install writes, and what a removal is judged against - a record without it is one an older
      // version left, which the preview is not pretending to be.
      type: "pluggable",
      complete: true,
      files: ["mods/fo2tweaks.dat", "mods/fo2tweaks.ini"],
      manifest: fo2tweaksManifest,
      shipped: { "mods/fo2tweaks.ini": fo2tweaksIni },
    },
  ],
});

/*
  Two builds of one engine, so the Run button's chooser has something to choose between and the Engines tab has
  rows. Written the way the cache writes them - the archive, and the note naming what it is - rather than through
  a download the preview refuses. `MemoryPlatform` is linux/x64, which is the asset `buildFor` picks.
*/
const cachedBuild = async (published: string) => {
  const at = `preview/cache/packages/engines/fallout2-ce/${published.replace(/[^0-9]/g, "")}`;
  await previewPlatform.fs.write(`${at}/fallout2-ce-linux-x64.tar.gz`, new TextEncoder().encode("preview"));
  await previewPlatform.fs.write(
    `${at}/release.json`,
    new TextEncoder().encode(JSON.stringify({ release: "continious", published, commit: null })),
  );
};

await cachedBuild("2026-07-01T00:00:00Z");
await cachedBuild("2026-08-23T09:37:22Z");

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
