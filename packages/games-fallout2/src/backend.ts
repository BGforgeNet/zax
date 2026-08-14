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
  saveConfigFiles,
  saveState,
  scanForInstalls,
  type AppState,
  type ConfigFileContents,
  type GameType,
  type Install,
  type LoadedState,
  type SaveOutcome,
  type SaveRequest,
  type ZaxRelease,
} from "@zax/core";
import type { OperatingSystem, Platform } from "@zax/platform";
import { CONFIG_FILES } from "./files.js";
import { insideMods, parseManifest, type ModSetting } from "./manifest.js";
import { MOD_FEEDS, fetchFeed, listAvailableMods, type ModListing } from "./mod-feed.js";
import {
  applyModInstall,
  planModInstall,
  restoreModInstall,
  uninstallMod,
  type ModInstallOutcome,
  type ModInstallPlan,
  type ModRemoval,
} from "./mod-install.js";
import { loadRecord, reconcileRecord } from "./records.js";
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
}

export interface Backend {
  describe(): Promise<MachineDescription>;
  /** A directory the user picked, or null if they cancelled. The picker belongs to the shell, not the page. */
  chooseFolder(): Promise<string | null>;
  loadState(): Promise<LoadedState>;
  saveState(state: AppState): Promise<void>;
  loadConfigFiles(installPath: string): Promise<ConfigFileContents>;
  saveConfigFiles(request: SaveRequest): Promise<SaveOutcome>;
  /** sfall's mod load order, and what sits in the folder it orders. */
  loadMods(install: Install): Promise<ModsSnapshot>;
  saveMods(request: ModsSaveRequest): Promise<SaveOutcome>;
  /** Every known mod against this install: what it is, and what can be done with it here. */
  availableMods(install: Install): Promise<ModListing>;
  /** Downloads and verifies a mod's newest release, answering the resolved plan the confirmation shows. */
  planMod(install: Install, modId: string): Promise<ModInstallPlan>;
  installMod(install: Install, modId: string): Promise<ModInstallOutcome>;
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
  /** Read only: nothing here installs the hi-res patch, so this reports what is there and stops. */
  installedHiresVersion(install: Install): Promise<string | null>;
  latestZax(): Promise<ZaxRelease>;
  listSaves(install: Install): Promise<readonly string[]>;
  createDebugPackage(install: Install, saves: readonly string[]): Promise<DebugPackage>;
  launch(install: Install, sfallVersion: string | null): Promise<void>;
  open(target: OpenTarget): Promise<void>;
  wipe(which: OwnDirectory): Promise<void>;
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
}

/**
 * What only the window's own shell can do. Kept out of the platform interface because it is not a capability of
 * the machine but of whatever is presenting the interface, and a browser has none.
 */
export interface Shell {
  chooseFolder(): Promise<string | null>;
  /**
   * Where progress goes. Optional: a host that has nowhere to show it simply does not pass one, and every
   * operation below still runs.
   */
  report?(progress: OperationProgress): void;
}

export function createBackend(platform: Platform, shell: Shell): Backend {
  /**
   * Carries the step and the byte counts to the interface as one message. They arrive separately - the step
   * from whichever part of the operation is starting, the counts from the transport, which knows nothing about
   * what it is fetching - so the last step named is what a set of counts is reported under.
   */
  const reporting = () => {
    let step = "";
    return {
      onStep: (named: string) => {
        step = named;
        shell.report?.({ step });
      },
      onProgress: ({ received, total }: { received: number; total: number | null }) =>
        shell.report?.({ step, received, total }),
    };
  };

  const own = (which: OwnDirectory) =>
    which === "backup"
      ? backupDirectory(platform)
      : which === "debug"
        ? debugDirectory(platform)
        : packageDirectory(platform);

  /** The feed release for a mod the interface named - never data the renderer supplied. */
  const releaseForMod = async (modId: string) => {
    const feed = MOD_FEEDS.find((entry) => entry.id === modId);
    if (!feed) throw new Error(`No known feed carries "${modId}".`);
    return fetchFeed(platform, feed);
  };

  /** The settings schemas the install's records carry. A snapshot a newer spec wrote is skipped, not fatal. */
  const installedModSettings = async (installPath: string): Promise<ModSettingsGroup[]> => {
    const groups: ModSettingsGroup[] = [];
    for (const mod of (await loadRecord(platform, installPath)).mods) {
      if (!mod.complete) continue;
      try {
        const manifest = parseManifest(new TextEncoder().encode(mod.manifest));
        // A mod without a schema gets no configuration surface - the schema is the convention.
        if (manifest.settings.length === 0) continue;
        groups.push({
          modId: manifest.id,
          name: manifest.name,
          files: [...new Set(manifest.settings.map((setting) => setting.file))],
          settings: manifest.settings,
        });
      } catch {
        // The mod stays installed and listed; only its configuration surface is missing, as it is for any
        // mod without a schema.
      }
    }
    return groups;
  };

  return {
    chooseFolder: () => shell.chooseFolder(),

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
      return loadConfigFiles(platform, installPath, [...names]);
    },
    saveConfigFiles: (request) => saveConfigFiles(platform, request),
    loadMods: (install) => readMods(platform, install),
    saveMods: (request) => saveMods(platform, request),

    availableMods: async (install) => {
      const record = await reconcileRecord(platform, await loadRecord(platform, install.path));
      const sfall = await installedSfallVersion(platform, install);
      return listAvailableMods(platform, install, record, sfall);
    },
    planMod: async (install, modId) => planModInstall(platform, install, await releaseForMod(modId), reporting()),
    installMod: async (install, modId) => {
      const release = await releaseForMod(modId);
      const progress = reporting();
      // Re-planned rather than trusting a plan the renderer held: the directory may have moved on since the
      // confirmation, and the plan is cheap against the already-verified archive.
      const plan = await planModInstall(platform, install, release, progress);
      return applyModInstall(platform, install, release, plan, progress, new Date());
    },
    restoreMod: (install, modId) => restoreModInstall(platform, install, modId),
    removeMod: (install, modId) => uninstallMod(platform, install, modId, new Date()),
    modSettings: (install) => installedModSettings(install.path),
    openModFile: async (install, modId, file) => {
      const mod = (await loadRecord(platform, install.path)).mods.find((held) => held.id === modId);
      if (!mod) throw new Error(`Nothing of "${modId}" is recorded for this install.`);
      // Bounded to the files the record itself declares - its state snapshots and its schema's files.
      const allowed = new Set(Object.keys(mod.shipped));
      try {
        for (const setting of parseManifest(new TextEncoder().encode(mod.manifest)).settings) {
          allowed.add(setting.file);
        }
      } catch {
        // An unreadable snapshot narrows what may be opened; it does not widen anything.
      }
      if (!allowed.has(file) || !insideMods(file)) throw new Error(`"${file}" is not one of ${modId}'s files.`);
      return platform.process.open(platform.paths.join(install.path, ...file.split("/")));
    },
    identifyInstall: (path) => identifyInstall(platform, path),
    scanForInstalls: (known) => scanForInstalls(platform, known, new Date()),

    installedSfallVersion: (install) => installedSfallVersion(platform, install),
    latestSfall: () => latestSfall(platform),
    updateSfall: (install, version) => updateSfall(platform, install, version, new Date(), reporting()),
    listSfallVersions: () => listSfallVersions(platform),
    installedHiresVersion: (install) => installedHiresVersion(platform, install),
    latestZax: () => latestZax(platform),

    listSaves: (install) => listSaves(platform, install),
    createDebugPackage: (install, saves) => createDebugPackage(platform, install, saves),

    launch: async (install, sfallVersion) => {
      const plan = planLaunch(platform.os, install, sfallVersion);
      await platform.process.launch(plan.program, plan.args, { cwd: plan.cwd, env: plan.env });
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

    // Recreated straight away, so the path the interface shows stays valid.
    wipe: async (which) => {
      await platform.fs.remove(own(which));
      await platform.fs.mkdir(own(which));
    },
  };
}
