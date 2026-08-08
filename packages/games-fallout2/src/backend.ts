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
export type OpenTarget = OwnDirectory | "log" | "releases";

export const RELEASES_PAGE = "https://github.com/BGforgeNet/zax/releases/latest";

export interface Backend {
  describe(): Promise<MachineDescription>;
  /** A directory the user picked, or null if they cancelled. The picker belongs to the shell, not the page. */
  chooseFolder(): Promise<string | null>;
  loadState(): Promise<LoadedState>;
  saveState(state: AppState): Promise<void>;
  loadConfigFiles(installPath: string): Promise<ConfigFileContents>;
  saveConfigFiles(request: SaveRequest): Promise<SaveOutcome>;
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
 * What only the window's own shell can do. Kept out of the platform interface because it is not a capability of
 * the machine but of whatever is presenting the interface, and a browser has none.
 */
export interface Shell {
  chooseFolder(): Promise<string | null>;
}

export function createBackend(platform: Platform, shell: Shell): Backend {
  const own = (which: OwnDirectory) =>
    which === "backup"
      ? backupDirectory(platform)
      : which === "debug"
        ? debugDirectory(platform)
        : packageDirectory(platform);

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
    loadConfigFiles: (installPath) => loadConfigFiles(platform, installPath, [...CONFIG_FILES]),
    saveConfigFiles: (request) => saveConfigFiles(platform, request),
    identifyInstall: (path) => identifyInstall(platform, path),
    scanForInstalls: (known) => scanForInstalls(platform, known, new Date()),

    installedSfallVersion: (install) => installedSfallVersion(platform, install),
    latestSfall: () => latestSfall(platform),
    updateSfall: (install, version) => updateSfall(platform, install, version),
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
      if (target === "releases") return platform.process.open(RELEASES_PAGE);
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
