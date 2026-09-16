/**
 * One typed wrapper per command the shell registers.
 *
 * This is the interface's half of the boundary. Its Rust half is the handler list in
 * `crates/shell/src/lib.rs`, and the two are the one place a name appears on each side - which is a
 * copy, so `commands.test.ts` reads that list and fails when the two sets differ. The types come from
 * `bindings/`, generated out of the Rust that defines them, so only the names are hand-kept.
 *
 * `invoke` takes its arguments as an object and converts each key from camelCase to the snake_case the
 * Rust parameter is named, which is why the objects below read the way they do.
 */

import { invoke } from "./invoke.js";

import type { AppState } from "./bindings/AppState";
import type { BuildPick } from "./bindings/BuildPick";
import type { DebugPackage } from "./bindings/DebugPackage";
import type { EngineListing } from "./bindings/EngineListing";
import type { EngineRelease } from "./bindings/EngineRelease";
import type { GameType } from "./bindings/GameType";
import type { HeldTarget } from "./bindings/HeldTarget";
import type { Install } from "./bindings/Install";
import type { InstallOutcome } from "./bindings/InstallOutcome";
import type { InstallPlan } from "./bindings/InstallPlan";
import type { InstalledEngine } from "./bindings/InstalledEngine";
import type { LoadedState } from "./bindings/LoadedState";
import type { MachineDescription } from "./bindings/MachineDescription";
import type { ModFeedListing } from "./bindings/ModFeedListing";
import type { ModInstallState } from "./bindings/ModInstallState";
import type { ModRemoval } from "./bindings/ModRemoval";
import type { ModSettingsGroup } from "./bindings/ModSettingsGroup";
import type { ModsSaveRequest } from "./bindings/ModsSaveRequest";
import type { ModsSnapshot } from "./bindings/ModsSnapshot";
import type { OpenTarget } from "./bindings/OpenTarget";
import type { OrderSwap } from "./bindings/OrderSwap";
import type { SaveOutcome } from "./bindings/SaveOutcome";
import type { SaveRequest } from "./bindings/SaveRequest";
import type { SfallRelease } from "./bindings/SfallRelease";
import type { SfallUpdate } from "./bindings/SfallUpdate";
import type { WipeTarget } from "./bindings/WipeTarget";
import type { ZaxRelease } from "./bindings/ZaxRelease";

/** Every command name, which is what the guard test compares against the shell's own list. */
export const COMMANDS = [
  "describe",
  "choose_folder",
  "load_state",
  "save_state",
  "load_config_files",
  "save_config_files",
  "settings_base",
  "accept_settings_base",
  "load_mods",
  "save_mods",
  "published_mods",
  "mod_install_state",
  "plan_mod",
  "install_mod",
  "mod_versions",
  "restore_mod",
  "remove_mod",
  "mod_settings",
  "open_mod_file",
  "identify_install",
  "scan_for_installs",
  "installed_sfall_version",
  "latest_sfall",
  "update_sfall",
  "list_sfall_versions",
  "machine_engines",
  "deployed_engines",
  "engine_releases",
  "fetch_engine",
  "forget_engine",
  "use_engine_build",
  "installed_hires_version",
  "latest_zax",
  "list_saves",
  "create_debug_package",
  "order_swap",
  "launch",
  "open",
  "wipe",
  "cancel",
] as const;

export type CommandName = (typeof COMMANDS)[number];

/** Contents by file name, as the bytes the seam carries. `null` is a file that is not there. */
export type ConfigFileContents = Readonly<Record<string, number[] | null>>;

export const commands = {
  describe: (): Promise<MachineDescription> => invoke("describe"),
  chooseFolder: (holding?: string): Promise<string | null> => invoke("choose_folder", { holding }),

  loadState: (): Promise<LoadedState> => invoke("load_state"),
  saveState: (state: AppState): Promise<void> => invoke("save_state", { state }),

  loadConfigFiles: (installPath: string): Promise<ConfigFileContents> =>
    invoke("load_config_files", { installPath }),
  saveConfigFiles: (request: SaveRequest): Promise<SaveOutcome> => invoke("save_config_files", { request }),
  settingsBase: (installPath: string): Promise<Readonly<Record<string, string>>> =>
    invoke("settings_base", { installPath }),
  acceptSettingsBase: (installPath: string, at: readonly HeldTarget[]): Promise<void> =>
    invoke("accept_settings_base", { installPath, at }),

  loadMods: (install: Install): Promise<ModsSnapshot> => invoke("load_mods", { install }),
  saveMods: (request: ModsSaveRequest): Promise<SaveOutcome> => invoke("save_mods", { request }),

  publishedMods: (refresh?: boolean): Promise<ModFeedListing> => invoke("published_mods", { refresh }),
  modInstallState: (install: Install): Promise<ModInstallState> => invoke("mod_install_state", { install }),
  planMod: (
    install: Install,
    modId: string,
    choices?: readonly string[],
    answers?: Readonly<Record<string, string>>,
    version?: string,
  ): Promise<InstallPlan> => invoke("plan_mod", { install, modId, choices, answers, version }),
  installMod: (
    install: Install,
    modId: string,
    fingerprint: string,
    choices?: readonly string[],
    answers?: Readonly<Record<string, string>>,
    version?: string,
  ): Promise<InstallOutcome> => invoke("install_mod", { install, modId, fingerprint, choices, answers, version }),
  modVersions: (modId: string, above?: string): Promise<string[]> => invoke("mod_versions", { modId, above }),
  restoreMod: (install: Install, modId: string): Promise<void> => invoke("restore_mod", { install, modId }),
  removeMod: (install: Install, modId: string): Promise<ModRemoval> => invoke("remove_mod", { install, modId }),
  modSettings: (install: Install): Promise<ModSettingsGroup[]> => invoke("mod_settings", { install }),
  openModFile: (install: Install, modId: string, file: string): Promise<void> =>
    invoke("open_mod_file", { install, modId, file }),

  identifyInstall: (path: string): Promise<GameType | null> => invoke("identify_install", { path }),
  scanForInstalls: (known: readonly Install[]): Promise<Install[]> => invoke("scan_for_installs", { known }),

  installedSfallVersion: (install: Install): Promise<string | null> =>
    invoke("installed_sfall_version", { install }),
  latestSfall: (): Promise<SfallRelease> => invoke("latest_sfall"),
  updateSfall: (install: Install, version: string): Promise<SfallUpdate> =>
    invoke("update_sfall", { install, version }),
  listSfallVersions: (): Promise<string[]> => invoke("list_sfall_versions"),

  machineEngines: (): Promise<EngineListing[]> => invoke("machine_engines"),
  deployedEngines: (install: Install): Promise<InstalledEngine[]> => invoke("deployed_engines", { install }),
  engineReleases: (engineId: string): Promise<EngineRelease[]> => invoke("engine_releases", { engineId }),
  fetchEngine: (engineId: string, published: string | null): Promise<EngineRelease> =>
    invoke("fetch_engine", { engineId, published }),
  forgetEngine: (engineId: string, published: string): Promise<void> =>
    invoke("forget_engine", { engineId, published }),
  useEngineBuild: (install: Install, engineId: string, pick: BuildPick): Promise<void> =>
    invoke("use_engine_build", { install, engineId, pick }),

  installedHiresVersion: (install: Install): Promise<string | null> =>
    invoke("installed_hires_version", { install }),
  latestZax: (): Promise<ZaxRelease> => invoke("latest_zax"),
  listSaves: (install: Install): Promise<string[]> => invoke("list_saves", { install }),
  createDebugPackage: (install: Install, saves: readonly string[]): Promise<DebugPackage> =>
    invoke("create_debug_package", { install, saves }),

  orderSwap: (install: Install, engineId: string | null): Promise<OrderSwap | null> =>
    invoke("order_swap", { install, engineId }),
  launch: (
    install: Install,
    sfallVersion: string | null,
    engineId: string | null,
    pick: BuildPick | null,
  ): Promise<void> => invoke("launch", { install, sfallVersion, engineId, pick }),
  open: (target: OpenTarget): Promise<void> => invoke("open", { target }),
  wipe: (which: WipeTarget): Promise<void> => invoke("wipe", { which }),
  cancel: (): Promise<void> => invoke("cancel"),
} as const;
