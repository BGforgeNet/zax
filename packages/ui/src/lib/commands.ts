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
 *
 * The state the interface draws lives on the other side. Most commands answer the whole view, or the
 * rows of it that changed, and the store is what lays that answer over the view it holds.
 */

import { invoke } from "./invoke.js";

import type { Answered } from "./bindings/Answered";
import type { AppView } from "./bindings/AppView";
import type { BuildPick } from "./bindings/BuildPick";
import type { CatalogView } from "./bindings/CatalogView";
import type { ChoiceGroup } from "./bindings/ChoiceGroup";
import type { DebugPackage } from "./bindings/DebugPackage";
import type { EngineRelease } from "./bindings/EngineRelease";
import type { InstallPlan } from "./bindings/InstallPlan";
import type { InstallReport } from "./bindings/InstallReport";
import type { ModInstallRequest } from "./bindings/ModInstallRequest";
import type { ModPart } from "./bindings/ModPart";
import type { OpenTarget } from "./bindings/OpenTarget";
import type { OrderEdit } from "./bindings/OrderEdit";
import type { OrderSwap } from "./bindings/OrderSwap";
import type { Requirement } from "./bindings/Requirement";
import type { SaveRefusal } from "./bindings/SaveRefusal";
import type { SearchResults } from "./bindings/SearchResults";
import type { SfallUpdate } from "./bindings/SfallUpdate";
import type { Started } from "./bindings/Started";
import type { Theme } from "./bindings/Theme";
import type { WineConfig } from "./bindings/WineConfig";
import type { WipeTarget } from "./bindings/WipeTarget";

/** Every command name, which is what the guard test compares against the shell's own list. */
export const COMMANDS = [
  "start",
  "view",
  "catalog",
  "search",
  "choose_folder",
  "select_install",
  "refresh",
  "add_install",
  "remove_install",
  "set_alias",
  "set_wine",
  "set_theme",
  "set_autosave",
  "accept_caution",
  "scan",
  "set_setting",
  "set_percent",
  "revert_settings",
  "apply_action",
  "satisfy_gate",
  "choose_linked",
  "edit_order",
  "save",
  "check_zax",
  "check_sfall",
  "check_engine",
  "list_sfall_versions",
  "change_sfall",
  "read_mod_listing",
  "plan_mod",
  "install_mod",
  "mod_versions",
  "restore_mod",
  "remove_mod",
  "open_mod_file",
  "toggle_mod_part",
  "fetch_engine",
  "forget_engine",
  "use_engine_build",
  "order_swap",
  "launch",
  "list_saves",
  "create_debug_package",
  "open",
  "wipe",
  "cancel",
] as const;

export type CommandName = (typeof COMMANDS)[number];

export const commands = {
  start: (version: string): Promise<Started> => invoke("start", { version }),
  view: (): Promise<AppView> => invoke("view"),
  catalog: (): Promise<CatalogView> => invoke("catalog"),
  search: (query: string): Promise<SearchResults> => invoke("search", { query }),
  chooseFolder: (holding?: string): Promise<string | null> => invoke("choose_folder", { holding }),

  selectInstall: (path: string): Promise<AppView> => invoke("select_install", { path }),
  refresh: (): Promise<AppView> => invoke("refresh"),
  addInstall: (path: string): Promise<Answered<string | null>> => invoke("add_install", { path }),
  removeInstall: (path: string): Promise<AppView> => invoke("remove_install", { path }),
  setAlias: (path: string, name: string): Promise<AppView> => invoke("set_alias", { path, name }),
  setWine: (path: string, wine: WineConfig): Promise<AppView> => invoke("set_wine", { path, wine }),
  setTheme: (theme: Theme): Promise<AppView> => invoke("set_theme", { theme }),
  setAutosave: (on: boolean): Promise<AppView> => invoke("set_autosave", { on }),
  acceptCaution: (engineId: string): Promise<AppView> => invoke("accept_caution", { engineId }),
  scan: (): Promise<Answered<number>> => invoke("scan"),

  setSetting: (id: string, value: string): Promise<AppView> => invoke("set_setting", { id, value }),
  setPercent: (id: string, percent: number): Promise<AppView> => invoke("set_percent", { id, percent }),
  revertSettings: (ids: readonly string[], all: boolean): Promise<AppView> =>
    invoke("revert_settings", { ids, all }),
  applyAction: (actionId: string): Promise<AppView> => invoke("apply_action", { actionId }),
  satisfyGate: (id: string, group: string | null): Promise<Answered<Requirement[]>> =>
    invoke("satisfy_gate", { id, group }),
  chooseLinked: (id: string, value: string): Promise<AppView> => invoke("choose_linked", { id, value }),
  editOrder: (edit: OrderEdit): Promise<AppView> => invoke("edit_order", { edit }),
  save: (): Promise<Answered<SaveRefusal | null>> => invoke("save"),

  checkZax: (): Promise<AppView> => invoke("check_zax"),
  checkSfall: (): Promise<AppView> => invoke("check_sfall"),
  checkEngine: (engineId: string): Promise<AppView> => invoke("check_engine", { engineId }),
  listSfallVersions: (): Promise<string[]> => invoke("list_sfall_versions"),
  changeSfall: (version: string | null): Promise<Answered<SfallUpdate>> => invoke("change_sfall", { version }),

  readModListing: (refresh: boolean): Promise<AppView> => invoke("read_mod_listing", { refresh }),
  planMod: (
    modId: string,
    choices?: readonly string[],
    answers?: Readonly<Record<string, string>>,
    version?: string,
  ): Promise<InstallPlan> => invoke("plan_mod", { modId, choices, answers, version }),
  installMod: (request: ModInstallRequest): Promise<Answered<InstallReport>> => invoke("install_mod", { request }),
  modVersions: (modId: string, above?: string): Promise<string[]> => invoke("mod_versions", { modId, above }),
  restoreMod: (modId: string): Promise<AppView> => invoke("restore_mod", { modId }),
  removeMod: (modId: string): Promise<AppView> => invoke("remove_mod", { modId }),
  openModFile: (modId: string, file: string): Promise<void> => invoke("open_mod_file", { modId, file }),
  toggleModPart: (
    groups: readonly ChoiceGroup<ModPart>[],
    chosen: readonly string[],
    id: string,
    on: boolean,
  ): Promise<string[]> => invoke("toggle_mod_part", { groups, chosen, id, on }),

  fetchEngine: (engineId: string, published: string | null): Promise<Answered<EngineRelease>> =>
    invoke("fetch_engine", { engineId, published }),
  forgetEngine: (engineId: string, published: string): Promise<AppView> =>
    invoke("forget_engine", { engineId, published }),
  useEngineBuild: (engineId: string, pick: BuildPick): Promise<AppView> =>
    invoke("use_engine_build", { engineId, pick }),
  orderSwap: (engineId: string | null): Promise<OrderSwap | null> => invoke("order_swap", { engineId }),
  launch: (engineId: string | null, pick: BuildPick | null): Promise<AppView> =>
    invoke("launch", { engineId, pick }),

  listSaves: (): Promise<string[]> => invoke("list_saves"),
  createDebugPackage: (saves: readonly string[]): Promise<DebugPackage> => invoke("create_debug_package", { saves }),
  open: (target: OpenTarget): Promise<void> => invoke("open", { target }),
  wipe: (which: WipeTarget): Promise<void> => invoke("wipe", { which }),
  cancel: (): Promise<void> => invoke("cancel"),
} as const;
