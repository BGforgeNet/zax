/**
 * Everything the interface asks the machine to do, as one flat list of operations.
 *
 * This is what crosses the process boundary in the desktop build, which is why it is operations rather than the
 * platform interface itself. Three reasons. Path joining is synchronous and cannot be proxied over an
 * asynchronous channel at all. One user action becomes one message instead of the dozens a file-by-file proxy
 * would send. And the privileged surface a renderer can reach is an enumerable list rather than "any file".
 *
 * Composed here because these are operations on a Fallout 2 install: the config files, sfall, the debug archive.
 */

import {
  backupDirectory,
  debugDirectory,
  packageDirectory,
  identifyInstall,
  latestZax,
  loadConfigFiles,
  loadState,
  logFile,
  ownTarget,
  saveConfigFiles,
  saveState,
  scanForInstalls,
  type AppState,
  type ConfigChange,
  type ConfigFileContents,
  type GameType,
  type Install,
  type LoadedState,
  type SaveOutcome,
  type SaveRequest,
  type ZaxRelease,
} from "@zax/core";
import type { OperatingSystem, Platform } from "@zax/platform";
import { engineConfigPaths } from "./engine-config.js";
import { addressOf, type HeldTarget } from "./reconcile-settings.js";
import { SETTINGS } from "./catalog.js";
import { CONFIG_FILES } from "./files.js";
import { mayWrite, parseManifest, type DroppedSetting, type ModSetting } from "./manifest.js";
import { grantsFor } from "./mod-grants.js";
import {
  MOD_FEEDS,
  fetchFeed,
  compareInLine,
  fetchFeedAt,
  listModVersions,
  readModFeeds,
  readModInstallState,
  type ModFeedListing,
  type ModInstallState,
  type ModRelease,
} from "./mod-feed.js";
import { applyBaseInstall, planBaseInstall, type BaseInstallOutcome, type BaseInstallPlan } from "./mod-base.js";
import {
  applyCreateInstall,
  planCreateInstall,
  type CreateInstallOutcome,
  type CreateInstallPlan,
} from "./mod-create.js";
import { datToolFor, ensureDatTool, type ReadyDatTool } from "./dat-tool.js";
import type { ModProgress } from "./mod-asset.js";
import {
  applyModInstall,
  planModInstall,
  restoreModInstall,
  uninstallMod,
  type ModInstallOutcome,
  type ModInstallPlan,
  type ModRemoval,
} from "./mod-install.js";
import { installCachedEngine, installedEngines, pinEngine } from "./engine-install.js";
import { cachedEngines, engineReleases, fetchEngineBuild, forgetEngine, type EngineRelease } from "./engine-release.js";
import { chooseBuild } from "./engine-choice.js";
import { ENGINES, buildFor, engineById, type ReleaseModel } from "./engines.js";
import { loadRecord, reconcileRecord, saveRecord, type InstalledEngine } from "./records.js";
import { readTransaction, releaseOf } from "./mod-transaction.js";
import { readMods, saveMods, type ModsSaveRequest, type ModsSnapshot } from "./mods.js";
import { createDebugPackage, listSaves, type DebugPackage } from "./debug-package.js";
import { installedHiresVersion } from "./hires.js";
import { planLaunch } from "./launch.js";
import {
  installedSfallVersion,
  latestSfall,
  listSfallVersions,
  updateSfall,
  type SfallRelease,
  type SfallUpdate,
} from "./sfall.js";

/**
 * Every address a linked setting writes. What `moveBase` records a base for: an address no link reaches has
 * nothing to reconcile against, so recording one would grow the record for nothing.
 */
const LINKED_ADDRESSES = new Set(
  SETTINGS.filter((setting) => setting.targets.length > 1).flatMap((setting) =>
    setting.targets.map((target) => addressOf(target)),
  ),
);

/** The application's own directories, and which machine this is. Read once, at startup. */
export interface MachineDescription {
  os: OperatingSystem;
  backupDirectory: string;
  debugDirectory: string;
  packageDirectory: string;
  logFile: string;
}

/** One of ZAX's own directories, named rather than passed as a path so a renderer cannot ask for another. */
export type OwnDirectory = "backup" | "debug" | "packages";

/** Something of ZAX's own the user can empty. The log is a file rather than a directory, hence its own arm. */
export type WipeTarget = OwnDirectory | "log";

/** Somewhere the desktop's own handler is asked to open. Named for the same reason. */
export type OpenTarget = OwnDirectory | "log" | "download";

export const RELEASES_PAGE = "https://github.com/BGforgeNet/zax/releases/latest";

/** One installed mod's configuration surface: who it belongs to, and the schema its record carries. */
export interface ModSettingsGroup {
  modId: string;
  name: string;
  /** The ini files the schema describes - what the open-the-file affordance opens. */
  files: readonly string[];
  settings: readonly ModSetting[];
  /**
   * Entries the schema declares that this version cannot draw. Carried so the surface can say what is
   * missing and why: a control quietly absent reads as a mod that never offered it.
   */
  dropped: readonly DroppedSetting[];
}

/** One build the machine holds, as a version list needs it. Addressed by `published`, not by tag. */
export interface CachedBuild {
  /** The release's tag, as published. A rolling project republishes one, so it does not identify a build. */
  release: string;
  /** When it was published, ISO 8601. The key a build is asked for by. */
  published: string;
  commit: string | null;
}

/**
 * One engine as the Engines tab needs it: what it is, what this machine would install, and which builds it
 * already holds. Nothing here is a game folder's business - what is deployed in one is `deployedEngines`.
 */
export interface EngineListing {
  id: string;
  name: string;
  short: string;
  page: string;
  /** How the project publishes, which decides whether a build is named to the user by tag or by date. */
  releases: ReleaseModel;
  /** What would be installed here, or null with `why` saying there is nothing. */
  build: { asset: string; program: string } | null;
  why?: string;
  /** What this machine holds, newest first. Empty is an engine nothing has fetched yet. */
  versions: readonly CachedBuild[];
}

export interface Backend {
  describe(): Promise<MachineDescription>;
  /**
   * A directory the user picked, or null if they cancelled. The picker belongs to the shell, not the page.
   *
   * `holding` names a file that directory must contain, and changes what the user is shown: a picker for that
   * file rather than for a folder, whose parent is what comes back. A folder picker hides files, so a user
   * asked for "the folder holding master.dat" has to recognise it by name alone - and the one thing that
   * would settle it is the file they are not allowed to see.
   */
  chooseFolder(holding?: string): Promise<string | null>;
  loadState(): Promise<LoadedState>;
  saveState(state: AppState): Promise<void>;
  loadConfigFiles(installPath: string): Promise<ConfigFileContents>;
  saveConfigFiles(request: SaveRequest): Promise<SaveOutcome>;
  /**
   * The base each address of a setting more than one engine carries is measured from, keyed by
   * `file|section|key`. Written by `saveConfigFiles` and by `acceptSettingsBase` below, so nothing outside
   * this interface can move a base out from under the reconciliation that reads it.
   */
  settingsBase(installPath: string): Promise<Readonly<Record<string, string>>>;
  /**
   * Moves those bases to the values named, without touching a file.
   *
   * What reverting a carried-across value does. The user has said these engines may disagree, and no file
   * changes when they do - so unless the bases move with them, the next load reads the same disagreement off
   * the same files and carries it across again. A later change inside an engine still reads as a move.
   */
  acceptSettingsBase(installPath: string, at: readonly HeldTarget[]): Promise<void>;
  /** sfall's mod load order, and what sits in the folder it orders. */
  loadMods(install: Install): Promise<ModsSnapshot>;
  saveMods(request: ModsSaveRequest): Promise<SaveOutcome>;
  /**
   * What every followed feed has published. The same answer for every install, so it is read once and held:
   * `refresh` is what the Mods tab's own control passes to ask the feeds again rather than be told what they
   * said before.
   */
  publishedMods(refresh?: boolean): Promise<ModFeedListing>;
  /**
   * Where one install stands against those mods - what is deployed in the folder, and what its record says.
   * This is the half a change of game invalidates; `listingFrom` puts the two back together.
   */
  modInstallState(install: Install): Promise<ModInstallState>;
  /**
   * Downloads and verifies a mod's newest release, answering the resolved plan the confirmation shows.
   * `choices` names what was picked before installing - a release's parts, or a base installer's components -
   * and is ignored by a release that offers neither. A base mod answers with the thinner plan of the two,
   * which says so: the installer decides what lands, so naming files there would be inventing them.
   */
  planMod(
    install: Install,
    modId: string,
    choices?: readonly string[],
    answers?: Readonly<Record<string, string>>,
    version?: string,
  ): Promise<ModInstallPlan | BaseInstallPlan | CreateInstallPlan>;
  /** Installs the plan whose fingerprint this is; one that no longer resolves the same is refused. */
  installMod(
    install: Install,
    modId: string,
    fingerprint: string,
    choices?: readonly string[],
    answers?: Readonly<Record<string, string>>,
    version?: string,
  ): Promise<ModInstallOutcome | BaseInstallOutcome | CreateInstallOutcome>;
  /**
   * The versions this mod's feed publishes, newest first, for a row that offers a choice rather than only the
   * release at the head of its line. Read from the cached listing, so asking costs nothing the feed has not
   * already paid for. `above` is what the install already carries, and the answer excludes it and everything
   * below: the comparison belongs here, where the release line that defines it is known.
   */
  modVersions(modId: string, above?: string): Promise<readonly string[]>;
  /** Unwinds an install that never finished; the working directory holds everything it puts back. */
  restoreMod(install: Install, modId: string): Promise<void>;
  removeMod(install: Install, modId: string): Promise<ModRemoval>;
  /** The installed mods' settings schemas, rendered by the same per-kind controls the catalog uses. */
  modSettings(install: Install): Promise<readonly ModSettingsGroup[]>;
  /**
   * Hands one of an installed mod's own files to the desktop's opener - the route to the sections a schema
   * does not cover. Bounded to files the mod's record declares, so a renderer cannot name another.
   */
  openModFile(install: Install, modId: string, file: string): Promise<void>;
  identifyInstall(path: string): Promise<GameType | null>;
  scanForInstalls(known: readonly Install[]): Promise<readonly Install[]>;
  installedSfallVersion(install: Install): Promise<string | null>;
  latestSfall(): Promise<SfallRelease>;
  updateSfall(install: Install, version: string): Promise<SfallUpdate>;
  listSfallVersions(): Promise<readonly string[]>;
  /** Every engine ZAX knows, against this machine. Answers from the catalog and the cache - no network. */
  machineEngines(): Promise<readonly EngineListing[]>;
  /** What is deployed in one game folder, reconciled against the directory. */
  deployedEngines(install: Install): Promise<readonly InstalledEngine[]>;
  /** What the project has published, newest first. */
  engineReleases(engineId: string): Promise<readonly EngineRelease[]>;
  /** Downloads a build into the machine's cache. `published` names one, or null for the newest published. */
  fetchEngine(engineId: string, published: string | null): Promise<EngineRelease>;
  /** Drops one build from the cache. Nothing is removed from any game folder. */
  forgetEngine(engineId: string, published: string): Promise<void>;
  /** Read only: nothing here installs the hi-res patch, so this reports what is there and stops. */
  installedHiresVersion(install: Install): Promise<string | null>;
  latestZax(): Promise<ZaxRelease>;
  listSaves(install: Install): Promise<readonly string[]>;
  createDebugPackage(install: Install, saves: readonly string[]): Promise<DebugPackage>;
  /**
   * `engineId` names an alternative engine, or null for the game's own executable. `published` names the build
   * to run, or null to follow what the folder holds and what the cache offers - see `engine-choice.ts`.
   */
  launch(
    install: Install,
    sfallVersion: string | null,
    engineId: string | null,
    published: string | null,
  ): Promise<void>;
  open(target: OpenTarget): Promise<void>;
  wipe(which: WipeTarget): Promise<void>;
  /**
   * Stops the running operation's transfer, if it has one. Resolves either way rather than reporting that
   * nothing was cancellable: the answer the caller acts on is what the operation itself then does, and a step
   * that finished between the click and this arriving is not an error anyone can act on.
   *
   * The operation rejects with `OperationCancelled` in place of its result. Whatever it had already fetched
   * stays where it is, so starting again resumes rather than repeating the transfer.
   */
  cancel(): Promise<void>;
}

/**
 * How far a long operation has got, in the words the interface shows. A plain object with plain fields because
 * it crosses a process boundary on the desktop: anything richer would arrive mangled or not at all.
 */
export interface OperationProgress {
  /** What is happening now - "Downloading sfall 4.5". */
  step: string;
  /** Bytes so far and bytes expected, when the step is a transfer and the server said how big it is. */
  received?: number;
  total?: number | null;
  /**
   * Whether `cancel` would reach this step. Declared rather than inferred from the byte counts being present:
   * the interface offers the button on this, and a control that is offered and does nothing is worse than one
   * that was never there.
   */
  cancellable?: boolean;
}

/**
 * What only the window's own shell can do. Kept out of the platform interface because it is not a capability of
 * the machine but of whatever is presenting the interface, and a browser has none.
 */
export interface Shell {
  /** `holding` asks for the folder by way of a file inside it - see the interface method of the same name. */
  chooseFolder(holding?: string): Promise<string | null>;
  /**
   * Where progress goes. Optional: a host that has nowhere to show it simply does not pass one, and every
   * operation below still runs.
   */
  report?(progress: OperationProgress): void;
}

export function createBackend(platform: Platform, shell: Shell): Backend {
  /**
   * The running operation's cancel. One at a time because the interface refuses to start a second while one
   * runs, and cleared as it is used so a click that arrives late cannot reach whatever started next.
   */
  let running: AbortController | null = null;

  /**
   * Carries the step and the byte counts to the interface as one message. They arrive separately - the step
   * from whichever part of the operation is starting, the counts from the transport, which knows nothing about
   * what it is fetching - so the last step named is what a set of counts is reported under.
   *
   * Also where the operation's cancel is minted, since this is the one thing every long operation takes. Only
   * the transfer honours it: a step that names no byte counts says so, and the interface stops offering the
   * button rather than offering one that would be ignored.
   */
  const reporting = () => {
    const controller = new AbortController();
    running = controller;
    let step = "";
    return {
      signal: controller.signal,
      onStep: (named: string) => {
        step = named;
        shell.report?.({ step, cancellable: false });
      },
      onProgress: ({ received, total }: { received: number; total: number | null }) =>
        shell.report?.({ step, received, total, cancellable: true }),
    };
  };

  const own = (which: OwnDirectory) =>
    which === "backup"
      ? backupDirectory(platform)
      : which === "debug"
        ? debugDirectory(platform)
        : packageDirectory(platform);

  /**
   * What the feeds published, read once and kept. A repository publishes one release whichever game folder is
   * selected, so re-reading it per install would spend the same requests - and, inside the feed cache's
   * window, the same parse of the same files - to arrive at the answer already held.
   *
   * Held as the promise rather than its result, so two reads starting at once make one request between them
   * and the second waits on the first. Assigned before it is awaited, which is what makes that true.
   */
  let feeds: Promise<{ listing: ModFeedListing; releases: readonly ModRelease[] }> | null = null;
  const feedsHeld = () => (feeds ??= readModFeeds(platform));

  /**
   * The same, for the two callers that are asking after the feeds themselves rather than needing a release
   * from them: startup and the Refresh control. `again` is Refresh, and a held answer carrying a refusal is
   * read again regardless - the machine that was offline when ZAX started may not be a minute later.
   *
   * That retry belongs here and not in `feedsHeld`, or an offline machine would attempt every feed again on
   * every change of game, which is the cost the two halves exist to avoid.
   */
  const feedsAsked = async (again: boolean) => {
    if (!again && (await feedsHeld()).listing.failures.length === 0) return feedsHeld();
    feeds = readModFeeds(platform);
    return feeds;
  };

  /**
   * The release a mod flow works on - never data the renderer supplied. An unfinished transaction answers
   * with the release it opened on, so a retry finishes the version it started: the copies it set aside are
   * that version's, and a feed that published a newer one meanwhile would otherwise leave a recovery
   * describing files that are no longer the ones on disk.
   */
  const releaseForMod = async (install: Install, modId: string, chosen?: readonly string[], version?: string) => {
    const open = await readTransaction(platform, install, modId);
    // An unfinished attempt decides its own selection too, and for the same reason: the copies waiting
    // beside it are those parts', and a second answer to the dialog would land on the first attempt's work.
    if (open) return { release: releaseOf(open), selection: open.selection ?? [] };
    const feed = MOD_FEEDS.find((entry) => entry.id === modId);
    if (!feed) throw new Error(`No known feed carries "${modId}".`);
    // A version the user picked is fetched by name; otherwise the release the listing was drawn from, so what
    // gets installed is the version the button offered. Going back to the feed for the newest here would let a
    // release published since open the plan the user never saw, and the confirmation compares the two - so the
    // flow would refuse itself rather than install anything.
    if (version !== undefined) return { release: await fetchFeedAt(platform, feed, version), selection: chosen ?? [] };
    const held = (await feedsHeld()).releases.find((one) => one.manifest.id === modId);
    return { release: held ?? (await fetchFeed(platform, feed)), selection: chosen ?? [] };
  };

  /**
   * The tool an extraction step needs, fetched and runnable. Which of its builds this machine gets is the
   * pin's business: a native one where upstream publishes it for this system and processor, and the portable
   * WebAssembly one otherwise, so every host can carry out the step.
   */
  const extractionTool = async (progress: ModProgress): Promise<ReadyDatTool> =>
    ensureDatTool(platform, datToolFor(platform.os, platform.arch), progress);

  /** The settings schemas the install's records carry. A snapshot a newer spec wrote is skipped, not fatal. */
  const installedModSettings = async (installPath: string): Promise<ModSettingsGroup[]> => {
    const groups: ModSettingsGroup[] = [];
    for (const mod of (await loadRecord(platform, installPath)).mods) {
      if (!mod.complete) continue;
      try {
        const manifest = parseManifest(new TextEncoder().encode(mod.manifest), { version: mod.version });
        // A mod without a schema gets no configuration surface - the schema is the convention. One whose
        // whole schema this version cannot draw still gets a section, or the reason would have nowhere to go.
        if (manifest.settings.length === 0 && manifest.dropped.length === 0) continue;
        groups.push({
          modId: manifest.id,
          name: manifest.name,
          files: [...new Set(manifest.settings.map((setting) => ownTarget(setting).file))],
          settings: manifest.settings,
          dropped: manifest.dropped,
        });
      } catch {
        // The mod stays installed and listed; only its configuration surface is missing, as it is for any
        // mod without a schema.
      }
    }
    return groups;
  };

  /**
   * Moves the base of each given address to the value named, which is what a later load compares against to
   * tell which side has moved since. Only addresses a link reaches: one no link reaches has nothing to
   * reconcile with, and recording every key would put the whole catalog in the record.
   *
   * Never fails the operation that asked for it. A record written by a newer ZAX is not ours to rewrite, and
   * a lost base only costs the preference between two values - the files themselves are already correct.
   */
  const moveBase = async (installPath: string, at: readonly ConfigChange[]): Promise<void> => {
    const relevant = at.filter((one) => LINKED_ADDRESSES.has(addressOf(one)));
    if (relevant.length === 0) return;
    const record = await loadRecord(platform, installPath);
    if (record.laterFormat !== undefined) return;
    const written = { ...record.written };
    for (const one of relevant) written[addressOf(one)] = one.value;
    await saveRecord(platform, { ...record, written });
  };

  return {
    chooseFolder: (holding) => shell.chooseFolder(holding),

    describe: async () => ({
      os: platform.os,
      backupDirectory: backupDirectory(platform),
      debugDirectory: debugDirectory(platform),
      packageDirectory: packageDirectory(platform),
      logFile: logFile(platform),
    }),

    loadState: () => loadState(platform),
    saveState: (state) => saveState(platform, state),
    loadConfigFiles: async (installPath) => {
      // The installed mods' settings files load through the same lossless path the engine's files do, so the
      // interface's guard-and-backup behaviour is one mechanism, not two.
      const names = new Set<string>(CONFIG_FILES);
      for (const group of await installedModSettings(installPath)) for (const file of group.files) names.add(file);
      const held = await loadConfigFiles(platform, installPath, [...names]);
      // Second, because where the content config sits is a setting inside the file just read.
      const paths = await engineConfigPaths(platform, installPath, held["fallout2.cfg"]);
      return { ...held, ...(await loadConfigFiles(platform, installPath, Object.keys(paths), paths)) };
    },
    saveConfigFiles: async (request) => {
      // Resolved against the contents the edits were made against, which is what the read used, so a save
      // writes where it read. A `master_patches` changed in the same save takes effect on the next load.
      const paths = await engineConfigPaths(platform, request.installPath, request.original["fallout2.cfg"]);
      const outcome = await saveConfigFiles(platform, { ...request, paths });
      if (outcome.ok) await moveBase(request.installPath, request.changes);
      return outcome;
    },
    settingsBase: async (installPath) => (await loadRecord(platform, installPath)).written ?? {},
    acceptSettingsBase: (installPath, at) =>
      moveBase(
        installPath,
        at.map((one) => ({ ...one.target, value: one.value })),
      ),
    loadMods: (install) => readMods(platform, install),
    saveMods: (request) => saveMods(platform, request),

    publishedMods: async (refresh = false) => (await feedsAsked(refresh)).listing,
    modInstallState: async (install) => {
      const record = await reconcileRecord(platform, await loadRecord(platform, install.path));
      const sfall = await installedSfallVersion(platform, install);
      return readModInstallState(platform, (await feedsHeld()).releases, install, record, sfall);
    },
    planMod: async (install, modId, choices, answers, version) => {
      const { release, selection } = await releaseForMod(install, modId, choices, version);
      const progress = reporting();
      if (release.manifest.creates) {
        return planCreateInstall(platform, install, release, answers ?? {}, await extractionTool(progress), progress);
      }
      return release.manifest.type === "base"
        ? planBaseInstall(platform, install, release, selection, progress)
        : planModInstall(platform, install, release, selection, progress);
    },
    installMod: async (install, modId, fingerprint, choices, answers, version) => {
      const { release, selection } = await releaseForMod(install, modId, choices, version);
      const progress = reporting();
      // Re-planned rather than trusting a plan the renderer held: the directory may have moved on since the
      // confirmation, and the plan is cheap against the already-verified archive. What runs is still what
      // was agreed to - a plan that resolved differently is refused here rather than quietly carried out.
      const stale = () =>
        new Error(
          `What installing ${release.manifest.name} would do has changed since you confirmed it - the game folder or the release moved on. Look at the new plan and confirm again.`,
        );
      if (release.manifest.creates) {
        const tool = await extractionTool(progress);
        const plan = await planCreateInstall(platform, install, release, answers ?? {}, tool, progress);
        if (plan.fingerprint !== fingerprint) throw stale();
        return applyCreateInstall(platform, install, release, plan, tool, progress, new Date());
      }
      if (release.manifest.type === "base") {
        const plan = await planBaseInstall(platform, install, release, selection, progress);
        if (plan.fingerprint !== fingerprint) throw stale();
        return applyBaseInstall(platform, install, release, plan, progress, new Date());
      }
      const plan = await planModInstall(platform, install, release, selection, progress);
      if (plan.fingerprint !== fingerprint) throw stale();
      return applyModInstall(platform, install, release, plan, progress, new Date());
    },
    modVersions: async (modId, above) => {
      const feed = MOD_FEEDS.find((entry) => entry.id === modId);
      if (!feed) throw new Error(`No known feed carries "${modId}".`);
      const versions = await listModVersions(platform, feed);
      if (above === undefined) return versions;
      return versions.filter((version) => compareInLine(feed.line, version, above) > 0);
    },
    restoreMod: (install, modId) => restoreModInstall(platform, install, modId, new Date()),
    removeMod: (install, modId) => uninstallMod(platform, install, modId, new Date()),
    modSettings: (install) => installedModSettings(install.path),
    openModFile: async (install, modId, file) => {
      const mod = (await loadRecord(platform, install.path)).mods.find((held) => held.id === modId);
      if (!mod) throw new Error(`Nothing of "${modId}" is recorded for this install.`);
      // Bounded to the files the record itself declares - its state snapshots and its schema's files.
      const allowed = new Set(Object.keys(mod.shipped));
      try {
        for (const setting of parseManifest(new TextEncoder().encode(mod.manifest), { version: mod.version })
          .settings) {
          allowed.add(ownTarget(setting).file);
        }
      } catch {
        // An unreadable snapshot narrows what may be opened; it does not widen anything.
      }
      if (!allowed.has(file) || !mayWrite(file, grantsFor(modId)))
        throw new Error(`"${file}" is not one of ${modId}'s files.`);
      return platform.process.open(platform.paths.join(install.path, ...file.split("/")));
    },
    identifyInstall: (path) => identifyInstall(platform, path),
    scanForInstalls: (known) => scanForInstalls(platform, known, new Date()),

    installedSfallVersion: (install) => installedSfallVersion(platform, install),
    latestSfall: () => latestSfall(platform),
    updateSfall: (install, version) => updateSfall(platform, install, version, new Date(), reporting()),
    listSfallVersions: () => listSfallVersions(platform),
    machineEngines: () =>
      Promise.all(
        ENGINES.map(async (engine) => {
          const build = buildFor(engine, platform.os, platform.arch);
          return {
            id: engine.id,
            name: engine.name,
            short: engine.short,
            page: engine.page,
            releases: engine.releases,
            build: build === null ? null : { asset: build.asset, program: build.program },
            ...(build === null ? { why: `${engine.name} publishes no build for this machine.` } : {}),
            versions:
              build === null
                ? []
                : (await cachedEngines(platform, engine, build.asset)).map((one) => ({
                    release: one.release.release,
                    published: one.release.published,
                    commit: one.release.commit,
                  })),
          };
        }),
      ),
    deployedEngines: (install) => installedEngines(platform, install),
    engineReleases: (engineId) => engineReleases(platform, engineId),
    fetchEngine: (engineId, published) => fetchEngineBuild(platform, engineId, published, reporting()),
    forgetEngine: (engineId, published) => forgetEngine(platform, engineById(engineId), published),
    installedHiresVersion: (install) => installedHiresVersion(platform, install),
    latestZax: () => latestZax(platform),

    listSaves: (install) => listSaves(platform, install),
    createDebugPackage: (install, saves) => createDebugPackage(platform, install, saves),

    // The program comes from the record and the catalog, never from the renderer - a caller that could name
    // the program would be naming a program for the machine to start.
    launch: async (install, sfallVersion, engineId, published) => {
      let program: string | null = null;
      if (engineId !== null) {
        const engine = engineById(engineId);
        const build = buildFor(engine, platform.os, platform.arch);
        if (!build) throw new Error(`${engine.name} publishes no build ZAX can run on this machine.`);
        const deployed = (await installedEngines(platform, install)).find((one) => one.id === engineId);
        const choice = chooseBuild(deployed, await cachedEngines(platform, engine, build.asset), published);
        if (choice.run === "nothing") {
          throw new Error(`ZAX has no copy of ${engine.name} to run here. Fetch one on the Engines tab first.`);
        }
        // Deploying is what choosing a build amounts to: a folder holds one, so switching means unpacking the
        // other over it - the same deployment, backup and record write an install has always made.
        if (choice.run === "deploy") {
          const at = { published: choice.build.release.published, pin: choice.pin };
          await installCachedEngine(platform, install, engineId, at, new Date(), reporting());
        } else if (choice.pin !== (deployed?.pinned ?? false)) {
          await pinEngine(platform, install, engineId, choice.pin);
        }
        program = build.program;
      }
      const plan = planLaunch(platform.os, install, sfallVersion, program);
      await platform.process.launch(plan.program, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        ...(plan.log !== undefined ? { log: plan.log } : {}),
      });
    },

    open: async (target) => {
      if (target === "download") {
        // Resolved here rather than named by the interface: a renderer that could give the address would be
        // handing an argument to the system's own opener. The page when the feed cannot be reached - a user who
        // pressed a download button was going there anyway, and it needs no request to name.
        const release = await latestZax(platform).catch(() => ({ url: RELEASES_PAGE }));
        return platform.process.open(release.url);
      }
      if (target === "log") return platform.process.open(logFile(platform));
      return platform.process.open(own(target));
    },

    // Recreated straight away, so the path the interface shows stays valid. The log needs no recreating:
    // the next line written makes it, which is what `appendLog` does when the file is not there at all.
    wipe: async (which) => {
      if (which === "log") return platform.fs.remove(logFile(platform));
      await platform.fs.remove(own(which));
      await platform.fs.mkdir(own(which));
    },

    // Taken as it is used, so a click that lands after its operation has already finished cannot abort the one
    // that started next.
    cancel: async () => {
      const controller = running;
      running = null;
      controller?.abort();
    },
  };
}
