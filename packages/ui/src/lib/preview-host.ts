/**
 * The in-memory machine used by the browser preview.
 *
 * The desktop build installs a backend on the window object, backed by the real platform in another process.
 * Opened in a browser there is none, so the preview builds one over an in-memory platform seeded with the
 * bundled fixture: everything that only touches files works for real, and everything that reaches the network
 * or starts a program says it cannot. Recording a launch that never happened, or inventing a version number,
 * would be worse than refusing.
 */

import type { Platform } from "@zax/platform";
import { MemoryPlatform } from "@zax/platform/memory";
import {
  createBackend,
  feedCachePath,
  saveRecord,
  wrapMethods,
  type Backend,
  type OperationProgress,
} from "@zax/fallout2";
import { PREVIEW_REASON, type BusySink, type ProgressSource } from "./host-contract.js";

import fallout2cfg from "../../../../fixtures/f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/f2up/ddraw.ini?raw";
// The ini FO2tweaks' release ships, verbatim, and a manifest for it written here - the mod publishes none of
// its own yet. Describing the real ini is what makes the settings surface worth showing; the document being
// ours is why the feed below records that this repository carries no manifest.
import fo2tweaksManifest from "../../../../fixtures/fo2tweaks/f2mod.yml?raw";
import fo2tweaksIni from "../../../../fixtures/fo2tweaks/mods/fo2tweaks.ini?raw";
// Real release listings, captured from each repository's own API and cut to the fields ZAX reads plus the
// newest releases of each line. Seeded into the feed cache below so the mods tab has rows in a browser: the
// listing is the one half of a feed that can be told honestly without a network, since it says what exists
// rather than doing anything.
import rpuFeed from "../../../../fixtures/preview/feeds/BGforgeNet-Fallout2_Restoration_Project.json?raw";
import upuFeed from "../../../../fixtures/preview/feeds/BGforgeNet-Fallout2_Unofficial_Patch.json?raw";
import fo1in2Feed from "../../../../fixtures/preview/feeds/rotators-Fo1in2.json?raw";
import fo2tweaksFeed from "../../../../fixtures/preview/feeds/BGforgeNet-FO2tweaks.json?raw";

/** The install the preview edits, named for what it is rather than as a plausible home directory. */
export const PREVIEW_INSTALL = "fixtures/f2up";

/*
  One install per game type, so every badge, every type-gated refusal and every base mod's eligibility is
  reachable in a browser. Only `f2up` carries a mods folder and a record - the rest exist to be a list with
  something in it and to be selected - but each is detected the way a real one is, from the marker files its
  type is actually known by rather than from anything declared here.
*/
const PREVIEW_GAMES: readonly { path: string; marks: readonly string[]; stamp?: string }[] = [
  // First because the interface opens on it: this is the one with a mods folder, a record and an engine
  // already deployed, so the preview starts on the install that has something to show rather than a bare one.
  { path: PREVIEW_INSTALL, marks: ["up-changelog.txt"] },
  { path: "fixtures/f2", marks: [] },
  { path: "fixtures/f2rp", marks: ["rp-changelog.txt"] },
  { path: "fixtures/f2upu", marks: ["mods/upu.dat"] },
  { path: "fixtures/f2rpu", marks: ["mods/rpu.dat"] },
  // A directory in a real install, holding the Fallout 1 data the conversion runs on; the type is read off
  // the entry's name, so what is under it only has to make the directory exist.
  //
  // Stamped with a Fallout et tu version rather than the sfall one every other fixture shares: this install
  // states its own, and a release behind the feed's is what a user of it usually has - which is the state its
  // mod row is about. `v1.15.3735` is the release before the one the canned feed offers.
  { path: "fixtures/fo1in2", marks: ["mods/fo1_base/fo1_base.dat"], stamp: "FALLOUT ET TU v1.15.3735" },
];

/** The state file a fresh preview starts from. The test fixture seeds its own, narrower, baseline. */
const PREVIEW_STATE_YML = `games:\n${PREVIEW_GAMES.map((game) => `- path: ${game.path}\n`).join("")}theme: system\n`;

/** Every file that makes one of those directories read as the install it is meant to be. */
const gameFiles = (): Record<string, string> =>
  Object.fromEntries(
    PREVIEW_GAMES.flatMap((game) => [
      [`${game.path}/fallout2.cfg`, fallout2cfg],
      [`${game.path}/f2_res.ini`, f2resini],
      // One line of the shared file rewritten where a game states its own version, so the fixture keeps every
      // sfall setting the tabs edit and differs only in what it says it is.
      [
        `${game.path}/ddraw.ini`,
        game.stamp ? ddrawini.replace(/^VersionString=.*$/m, `VersionString=${game.stamp}`) : ddrawini,
      ],
      [`${game.path}/fallout2.exe`, ""],
      ...game.marks.map((mark) => [`${game.path}/${mark}`, ""] as const),
    ]),
  );

function refuses(): never {
  throw new Error(PREVIEW_REASON);
}

/*
  The one thing the preview answers rather than refuses: each repository's release listing, captured verbatim
  from its own API. A listing states what exists and does nothing with it, so a real capture of one is not the
  invented version number the rest of this seam refuses to produce - and it lets the mods tab perform its real
  read, cache write included, instead of showing four rows saying it cannot. Downloads still refuse, so an
  install offered here still stops at the point where it would need the machine.

  Seeded as a network answer rather than straight into the feed cache because `MemoryPlatform` keeps a fake
  clock: a file it writes is dated 2023 whatever the real time is, so a seeded listing always reads as stale
  and the fetch happens anyway.
*/
const CAPTURED_FEEDS: Readonly<Record<string, string>> = {
  "BGforgeNet/Fallout2_Restoration_Project": rpuFeed,
  "BGforgeNet/Fallout2_Unofficial_Patch": upuFeed,
  "rotators/Fo1in2": fo1in2Feed,
  "BGforgeNet/FO2tweaks": fo2tweaksFeed,
};

function fetchCaptured(url: string): Promise<string> {
  const captured = Object.entries(CAPTURED_FEEDS).find(([repository]) => url.includes(`/repos/${repository}/releases`));
  // A manifest URL reaches here too, and still refuses - though nothing asks, since every one of these
  // repositories publishes no manifest and the cache below already records that.
  if (captured === undefined) refuses();
  return Promise.resolve(captured[1]);
}

/** The in-memory disk the preview edits. Exported so tests can reseed it between cases. */
export const previewPlatform: Platform = (() => {
  const memory = new MemoryPlatform({
    home: "preview",
    config: "preview/config",
    cache: "preview/cache",
    files: {
      ...gameFiles(),
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
      "preview/config/zax.yml": PREVIEW_STATE_YML,
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
    net: { fetchText: fetchCaptured, download: refuses },
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

/*
  Per release, the note that its author publishes no manifest of their own - which is what sends the base mods
  to the documents ZAX carries for exactly that case. True of all four: none of these repositories has an
  `f2mod.yml`, at the tag or on its default branch, so the note records the answer the network would give.
*/
for (const [repository, body] of Object.entries(CAPTURED_FEEDS)) {
  for (const release of JSON.parse(body) as { tag_name: string }[]) {
    await previewPlatform.fs.write(
      `${feedCachePath(previewPlatform, repository, release.tag_name)}.none`,
      new Uint8Array(),
    );
  }
}

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

/**
 * The preview's own progress, built here rather than refused: the backend it runs is in this process, so it
 * can report exactly as the desktop's does. Which means the interface's progress display is exercised by the
 * preview and by its tests, instead of only existing on the build that is hardest to drive.
 */
const previewListeners: Array<(progress: OperationProgress) => void> = [];

// No picker in a browser, and a made-up path would name a folder nobody has.
export const backend: Backend = copyingArguments(
  createBackend(previewPlatform, {
    chooseFolder: refuses,
    report: (progress) => previewListeners.forEach((listener) => listener(progress)),
  }),
);

export const progressSource: ProgressSource = {
  subscribe: (listener) => previewListeners.push(listener),
};

// Dropped in the preview rather than acted on: a browser tab's close is the browser's to decide, and the disk
// under the preview is in memory - nothing there outlives the tab to be left part way through.
export const busySink: BusySink = { set: () => {} };
