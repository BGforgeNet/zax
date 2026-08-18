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

/*
  An installed mod for the preview, so the settings-schema surface exists somewhere file-shaped. The keys,
  values and help lines are FO2tweaks' own, taken from its published ini; the schema is a hand-written sample
  of what its release would carry, including the real cross-file gate its readme states (damage_mod requires
  sfall's DamageFormula at 0).
*/
const PREVIEW_MOD_INI =
  "[main]\n" +
  "; don't penalize scoped weapons chance to hit at close range\n" +
  "no_scope_penalty=1\n" +
  "; Automatically open/walk through unlocked doors when not in combat\n" +
  "autodoors=1\n" +
  "; Limit max knockback distance in hexes. -1 is vanilla (unlimited). 0 is no knockback at all.\n" +
  "max_knockback=-1\n" +
  "; AP/JHP damage mod. You must set DamageFormula=0 in ddraw.ini for this component to work correctly.\n" +
  "damage_mod=1\n" +
  "\n" +
  "[run_speed]\n" +
  "; You can enable run speed increase for the Chosen, party, or both.\n" +
  "dude=1\n" +
  "party=1\n";

const PREVIEW_MOD_MANIFEST = `spec: 1
id: fo2tweaks
name: FO2tweaks
version: "14.7"
game: fallout2
settings:
  main.no_scope_penalty:
    kind: bool
    default: 1
    label: No scope penalty
    help: Don't penalize scoped weapons chance to hit at close range.
  main.autodoors:
    kind: choice
    options:
      - { value: 0, label: "Off" }
      - { value: 1, label: "Open" }
      - { value: 2, label: "Open and close" }
    default: 1
    label: Automatic doors
    help: Walk through unlocked doors without clicking, outside combat.
  main.max_knockback:
    kind: int
    min: -1
    sentinels: { "-1": "Vanilla (unlimited)", "0": "No knockback" }
    default: -1
    label: Max knockback
    help: Limit knockback distance in hexes.
  main.damage_mod:
    kind: bool
    default: 1
    label: AP/JHP damage mod
    help: Needs sfall's DamageFormula at 0 to work correctly.
    gated-by: { id: sfall.Misc.DamageFormula, is: [0] }
  run_speed.dude:
    kind: bool
    default: 1
    label: The Chosen One
    help: Increase run speed for the player when wearing armor.
  run_speed.party:
    kind: bool
    default: 1
    label: Party members
    help: Increase run speed for party members.
`;

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
        names, and one the record below claims - the only kind that shows an owner. None of these names is a
        marker `detectGameType` reads, or seeding them would relabel the preview install as a different game.
      */
      [`${PREVIEW_INSTALL}/mods/mods_order.txt`]:
        "; Loaded in this order - a mod further down overrides one above it.\n" +
        "weapon_sounds.dat\n; extra_music.dat\nhero_appearance\nold_patch.dat\nfo2tweaks.dat\n",
      [`${PREVIEW_INSTALL}/mods/fo2tweaks.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/weapon_sounds.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/extra_music.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/barter_prices.dat`]: "",
      [`${PREVIEW_INSTALL}/mods/hero_appearance/art/critters/hmjmps.frm`]: "",
      [`${PREVIEW_INSTALL}/mods/fo2tweaks.ini`]: PREVIEW_MOD_INI,
      "preview/config/zax.yml": `games:\n- path: ${PREVIEW_INSTALL}\ntheme: system\n`,
    },
  });

  return {
    os: memory.os,
    fs: memory.fs,
    paths: memory.paths,
    archive: memory.archive,
    hash: memory.hash,
    // Answers nothing, which is the truth rather than a refusal: a browser has no registry, and "no such key"
    // is what a scan does with every machine that has none of these launchers.
    registry: memory.registry,
    // Nothing here can be simulated honestly: a recorded launch and an invented release both read as success.
    process: { launch: refuses, open: refuses },
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
      version: "14.7",
      // What an install writes, and what a removal is judged against - a record without it is one an older
      // version left, which the preview is not pretending to be.
      type: "pluggable",
      complete: true,
      files: ["mods/fo2tweaks.dat", "mods/fo2tweaks.ini"],
      manifest: PREVIEW_MOD_MANIFEST,
      shipped: { "mods/fo2tweaks.ini": PREVIEW_MOD_INI },
    },
  ],
});

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
