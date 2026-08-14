import {
  IniDocument,
  addInstall,
  compareVersions,
  describeValueTest,
  isApplied,
  matchesValueTest,
  removeInstall,
  searchText,
  setAlias,
  withWine,
  type Action,
  type ActionGroup,
  type ConfigChange,
  type ConfigFileContents,
  type Install,
  type SettingDef,
  type StoredInstall,
  type Theme,
  type ValueTest,
  type WineConfig,
} from "@zax/core";
import {
  ACTIONS,
  CONFIG_FILES,
  MODS_ORDER_PATH,
  SETTINGS,
  describePlace,
  hiddenIds,
  listMods,
  placesById,
  wrapMethods,
  type Backend,
  type MachineDescription,
  type Mod,
  type ModInstallPlan,
  type ModListing,
  type ModOffer,
  type ModSetting,
  type ModSettingsGroup,
  type ModsSnapshot,
  type OpenTarget,
  type OperationProgress,
  type OwnDirectory,
  type Place,
  type SfallRelease,
} from "@zax/fallout2";
import { backend as host, isPreview, progressSource } from "./host.js";

/**
 * Every argument is unwrapped before it leaves the interface. The store holds its state in reactive proxies,
 * and a proxy cannot be structured-cloned - which is exactly what the desktop build's channel does to it, so
 * passing one straight through fails there with "an object could not be cloned" and works everywhere else.
 * Done once here rather than per call site, where the next operation added would forget it.
 *
 * Exported so a test can assert the unwrapping happens: Node's own `structuredClone` accepts a proxy where
 * Electron's serializer rejects it, so nothing short of checking this directly catches a regression here.
 */
export function unwrapArguments(backend: Backend): Backend {
  // Called rather than passed by reference: the compiler rewrites `$state.snapshot(x)`, not a bare mention.
  return wrapMethods(
    backend,
    (call) =>
      (...args: unknown[]) =>
        call(...args.map((arg) => $state.snapshot(arg))),
  );
}

const backend: Backend = unwrapArguments(host);

/*
  Long enough that a slider drag or a series of quick edits lands as one write, short enough that a user who
  changed one thing and looked away sees it saved. Each save rewrites a config file and copies the old one.
*/
const AUTOSAVE_DELAY = 400;

// Built once: the layout does not change at runtime, and every search result needs a lookup in it.
const PLACES = placesById();
const HIDDEN = hiddenIds();

const CURATED = new Map(SETTINGS.map((s) => [`${s.file}|${s.section}|${s.key}`.toLowerCase(), s]));

// Built once for the same reason as the maps above: the layout tab asks for a definition once per node on
// every render, and a scan of the catalog per ask multiplies out on exactly the render that draws all of it.
const BY_ID = new Map(SETTINGS.map((s) => [s.id, s]));

/**
 * Every setting search can reach, with its address and the text matched against, built once at load. None of
 * it depends on anything that changes at runtime, and rebuilding it per query meant lowercasing 164 strings
 * on every keystroke.
 */
const SEARCHABLE: ReadonlyArray<{ def: SettingDef; place: Place; where: string; hay: string }> = SETTINGS.flatMap(
  (def) => {
    const place = PLACES.get(def.id);
    // A pinned value is drawn even where the layout hides it, so it stays findable for the same reason.
    if (!place || (HIDDEN.has(def.id) && !def.managed)) return [];
    const where = describePlace(place);
    const hay = `${searchText(def)} ${where.toLowerCase()}`;
    return [{ def, place, where, hay }];
  },
);

/**
 * Every key the config files actually contain. The catalog curates 166 of them; sfall's ddraw.ini alone holds
 * 115 keys, most undocumented by the catalog but documented by its own inline comments, which become the help
 * text for free.
 */
function discover(documents: Record<string, IniDocument>): SettingDef[] {
  const out: SettingDef[] = [];
  for (const file of CONFIG_FILES) {
    for (const entry of documents[file]?.entries() ?? []) {
      const curated = CURATED.get(`${file}|${entry.section}|${entry.key}`.toLowerCase());
      if (curated) {
        out.push(curated);
        continue;
      }
      out.push({
        id: `raw.${file}.${entry.section}.${entry.key}`.toLowerCase(),
        file,
        section: entry.section,
        key: entry.key,
        kind: /^-?\d+$/.test(entry.value) ? { type: "int" } : { type: "text" },
        label: entry.key,
        ...(entry.comment ? { help: entry.comment } : {}),
      });
    }
  }
  return out;
}

/**
 * Troubleshooting's own tab. A fix is one click and a report is a sequence you work through, so they are
 * separated rather than stacked on one screen where neither reads as the whole of it.
 */
export type TroubleTab = "report" | "fixes";

/** Which sub-tab of Settings, by config file - plus Wine, which edits the install rather than a file. */
export type SettingsTab = string;

/**
 * The sidebar's own tab. Separate from `view` because the column stays put while the main pane changes - the
 * install you are editing is context for every view rather than a destination of its own.
 */
export type Panel = "games" | "zax";

/**
 * What the main pane shows. The two are different subjects rather than two tabs of one - settings are keys in
 * config files, mods are what the engine loads - so the switch between them sits above the tab strips both
 * carry, not inside either.
 */
export type View = "settings" | "mods";

/** The Mods view's own tabs: getting mods, ordering them, and configuring them are three different jobs. */
export type ModsTab = "installation" | "order" | "settings";

/** Something that happened and the user needs told: a save, a refusal, a failure. */
export interface Notice {
  kind: "done" | "problem";
  text: string;
}

/**
 * Edits are held as a sparse override map rather than applied to the parsed documents. That keeps
 * "what did I change" and revert trivial, and it is the shape a saved profile will store.
 */
class Store {
  view = $state<View>("settings");
  panel = $state<Panel>("games");
  troubleTab = $state<TroubleTab>("report");
  /** Which Settings sub-tab: a config file, or "install". */
  settingsTab = $state<SettingsTab>("fallout2.cfg");
  /**
   * Bumped to ask the install tab's alias field for focus. A counter rather than a flag: two requests in a row
   * must both land, and nothing has to reset it afterwards.
   */
  aliasRequest = $state(0);
  /** The same shape, for the filter on the "all settings" tab, which Ctrl-F reaches from anywhere. */
  searchRequest = $state(0);
  /** The selected tab within each file, kept per file so switching files does not reset the other's place. */
  fileTab = $state<Record<string, string>>({});
  query = $state("");
  installs = $state<readonly Install[]>([]);
  selectedInstall = $state<string>("");
  theme = $state<Theme>("system");
  /** Whether an edit is written as it is made. Off by default: writing to a game folder is opt-in. */
  autosave = $state(false);
  overrides = $state<Record<string, string>>({});

  /** Contents of the selected install's config files, exactly as they were read. */
  contents = $state<ConfigFileContents>({});

  /**
   * What the feeds offer this install, or null before the first read. Read when asked rather than at
   * startup: it costs the network, and the Mods view is where the answer means anything.
   */
  modListing = $state<ModListing | null>(null);
  /** A resolved install plan awaiting the user's word, with the offer it belongs to. */
  modPlan = $state<{ offer: ModOffer; plan: ModInstallPlan } | null>(null);
  /** The installed mods' settings schemas, rendered with the same per-kind controls the catalog gets. */
  modSettings = $state<readonly ModSettingsGroup[]>([]);
  /** Which of the Mods view's tabs is showing. */
  modsTab = $state<ModsTab>("installation");
  /** The selected section sub-tab within each mod's settings, kept per mod as `fileTab` is per file. */
  modSectionTab = $state<Record<string, string>>({});
  /** The same schemas by entry id - what value lookup, gates and pending changes resolve through. */
  private modById = new Map<string, ModSetting>();

  /** The install's mods, in load order, with whatever the user has changed about it since it was read. */
  mods = $state<readonly Mod[]>([]);
  /** The same list as it was read, which is what makes "changed" a comparison rather than a flag to maintain. */
  private modsBaseline = $state<readonly Mod[]>([]);
  /** The order file as it was read, so a save can refuse one that changed underneath. */
  private modsText: string | undefined = undefined;
  /** False until the first read of the state file and the selected install's config files has finished. */
  loaded = $state(false);
  /** The operation in progress, for disabling the controls that would start a second one. */
  busy = $state<string | null>(null);
  /**
   * How far that operation has got, when it is the kind that can say. Cleared with the operation, so nothing
   * is left reading 100% after the thing it was measuring has finished.
   */
  progress = $state<OperationProgress | null>(null);
  notice = $state<Notice | null>(null);

  /** The step and, where the length is known, the proportion - for one line under the operation's name. */
  get progressText(): string | null {
    const at = this.progress;
    if (!at) return null;
    if (at.received === undefined || at.total === undefined || at.total === null || at.total === 0) return at.step;
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    return `${at.step} - ${Math.floor((at.received / at.total) * 100)}% of ${mb(at.total)} MB`;
  }

  sfallInstalled = $state<string | null>(null);
  sfallLatest = $state<SfallRelease | null>(null);
  /** The hi-res patch's version, or null when the install does not have it. There is no latest to compare. */
  hiresInstalled = $state<string | null>(null);
  zaxLatest = $state<string | null>(null);

  /**
   * Installs the state file lists but that could not be read. Held so saving the file writes them back rather
   * than turning a drive being offline for one session into losing the entry.
   */
  private unavailable: readonly StoredInstall[] = [];

  /** Read once at startup: which machine this is and where its own directories are. */
  private machine = $state<MachineDescription | null>(null);

  /** The last search and what it produced - see `results`. Plain, not a rune, on purpose. */
  private cachedResults: {
    query: string;
    rows: ReadonlyArray<{ def: SettingDef; place: Place; where: string }>;
  } | null = null;

  /**
   * The values on disk, and every key the files actually hold. Computed when an install is read rather than
   * derived from `contents`: this is three file parses and a pass over 166 settings, and a derivation would
   * repeat it on every access from a plain function call.
   */
  private baseline: Record<string, string | undefined> = $state({});
  private rawBaseline: Record<string, string | undefined> = $state({});
  discovered = $state<SettingDef[]>([]);

  private index(): void {
    const modDefs = [...this.modById.values()];
    // The mods' ini files parse alongside the engine's; `discover` still walks CONFIG_FILES alone, so the
    // raw every-key view never extends to mod inis - the schema is their whole surface, by design.
    const files = [...new Set<string>([...CONFIG_FILES, ...modDefs.map((s) => s.file)])];
    const documents = Object.fromEntries(files.map((f) => [f, IniDocument.parse(this.contents[f] ?? "")]));
    const valueOf = (s: SettingDef) => documents[s.file]?.get(s.section, s.key);
    this.discovered = discover(documents);
    this.baseline = Object.fromEntries([...SETTINGS, ...modDefs].map((s) => [s.id, valueOf(s)]));
    this.rawBaseline = Object.fromEntries(this.discovered.map((s) => [s.id, valueOf(s)]));
  }

  /**
   * Values ZAX pins regardless of what the file says, and which the file does not already carry. UAC_AWARE=1
   * makes the high-resolution patch read its settings from roaming appdata instead of the game folder, so
   * leaving it on means editing an ini the patch never reads. `applyPins` is what writes them.
   */
  private managedOverrides(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of SETTINGS) {
      // Not for a file the install does not have: a pending change there would put the config file of an
      // uninstalled component into the game folder on the next save, which is the opposite of pinning a value.
      if (!this.hasFile(s.file)) continue;
      if (s.managed && this.baselineOf(s.id) !== s.managed.value) out[s.id] = s.managed.value;
    }
    return out;
  }

  /** Reads the machine's own description and state file, then the selected install. Runs once, at startup. */
  async start(): Promise<void> {
    // Before anything that could report: a subscription taken out afterwards would miss the first steps of
    // whatever is already running.
    progressSource.subscribe((progress) => {
      // Only while something is running. A message that outlives its operation - one still in flight when the
      // call failed - would otherwise sit under an idle interface saying work was going on.
      if (this.busy !== null) this.progress = progress;
    });
    this.machine = await backend.describe();
    const { state, problem } = await backend.loadState();
    this.installs = state.installs;
    this.unavailable = state.unavailable;
    this.theme = state.theme;
    this.autosave = state.autosave;
    this.selectedInstall = state.installs[0]?.path ?? "";
    if (problem) this.notice = { kind: "problem", text: problem };
    await this.readInstall();
    this.loaded = true;
  }

  /** Rereads the selected install: its config files and which sfall and hi-res patch it has. */
  private async readInstall(): Promise<void> {
    const install = this.install;
    this.sfallInstalled = null;
    this.hiresInstalled = null;
    // Another install's offers would be wrong here, and a held plan doubly so; the view re-asks on demand.
    this.modListing = null;
    this.modPlan = null;
    if (!install) {
      this.contents = {};
      this.modSettings = [];
      this.modById = new Map();
      this.index();
      this.overrides = {};
      this.setMods({ text: undefined, present: [] });
      return;
    }
    this.contents = await backend.loadConfigFiles(install.path);
    // Before the index, which folds the schemas' values into the baseline the controls read.
    this.modSettings = await backend.modSettings(install);
    this.modById = new Map(this.modSettings.flatMap((group) => group.settings.map((s) => [s.id, s])));
    this.index();
    this.overrides = await this.applyPins(install.path);
    await this.readMods(install);
    this.sfallInstalled = await backend.installedSfallVersion(install);
    this.hiresInstalled = await backend.installedHiresVersion(install);
  }

  /** Rereads the mod order alone, which is what a save of it has to do to leave a fresh baseline behind. */
  private async readMods(install: Install): Promise<void> {
    this.setMods(await backend.loadMods(install));
  }

  private setMods(snapshot: ModsSnapshot): void {
    this.modsText = snapshot.text;
    this.mods = listMods(snapshot);
    this.modsBaseline = this.mods;
  }

  /**
   * Writes the pinned values, and answers with whatever would not take.
   *
   * A pin is ZAX's own, not the user's, so it is written on sight rather than queued behind the Save button and
   * counted as an unsaved change - which left every install permanently one edit behind with nothing the user
   * had done to explain it. The setting still shows its pinned value and the reason for it, which is where a
   * user sees a pin; the unsaved count is for their own edits. Written whatever `autosave` says, for the same
   * reason: the setting governs edits, and this is not one.
   *
   * A pin that does not take is returned as a pending change, so it is visible rather than silently retried on
   * every read - and so this cannot write in a loop against a file that will not hold the value.
   */
  private async applyPins(installPath: string): Promise<Record<string, string>> {
    const wanted = this.managedOverrides();
    if (Object.keys(wanted).length === 0) return {};

    const outcome = await backend.saveConfigFiles({
      installPath,
      original: this.contents,
      changes: this.pendingChanges(wanted),
    });
    if (!outcome.ok) return wanted;

    this.contents = await backend.loadConfigFiles(installPath);
    this.index();
    return this.managedOverrides();
  }

  /** Runs one outward-facing operation, reporting whatever it fails with rather than swallowing it. */
  private async run(what: string, work: () => Promise<Notice | null>): Promise<void> {
    if (this.busy !== null) {
      // Said rather than dropped. These operations can run for minutes on a poor connection, and a click that
      // does nothing at all reads as the button being broken rather than as the application being busy.
      this.notice = { kind: "problem", text: `${this.busy} is still running - wait for it to finish.` };
      return;
    }
    this.busy = what;
    this.notice = null;
    try {
      this.notice = await work();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.notice = { kind: "problem", text: `${what} failed: ${reason}` };
    } finally {
      this.busy = null;
      this.progress = null;
    }
  }

  private async persist(): Promise<void> {
    await backend.saveState({
      installs: this.installs,
      unavailable: this.unavailable,
      theme: this.theme,
      autosave: this.autosave,
    });
  }

  /** Writes every target of an action in one step, so it lands as a single user-visible change. */
  applyAction(action: Action): void {
    const next = { ...this.overrides };
    for (const [id, want] of Object.entries(action.targets)) {
      if (want === this.baselineOf(id)) delete next[id];
      else next[id] = want;
    }
    this.overrides = next;
    this.scheduleAutosave();
  }

  actionApplied(action: Action): boolean {
    return isApplied(action, (id) => this.valueOf(id));
  }

  baselineOf(id: string): string | undefined {
    return id in this.baseline ? this.baseline[id] : this.rawBaseline[id];
  }

  valueOf(id: string): string | undefined {
    return id in this.overrides ? this.overrides[id] : this.baselineOf(id);
  }

  defOf(id: string): SettingDef | undefined {
    return BY_ID.get(id) ?? this.modById.get(id);
  }

  /**
   * The key is not in the config file at all - usually because the installed component predates it. The engine
   * falls back to its own built-in default, so this is not the same as an empty value.
   */
  isAbsent(id: string): boolean {
    return this.baselineOf(id) === undefined;
  }

  /**
   * Whether a gated setting currently has any effect, and what would make it live. Returns null for settings
   * that are not gated at all.
   */
  gateOf(def: SettingDef): { active: boolean; controller: SettingDef; wants: string } | null {
    if (!def.gatedBy) return null;
    // Through `defOf` rather than the catalog alone: a mod setting may gate on a sibling of its own schema,
    // or across files on a catalog id - the manifest validator has already refused anything else.
    const controller = this.defOf(def.gatedBy.id);
    if (!controller) return null;
    return {
      active: matchesValueTest(controller, this.valueOf(controller.id), def.gatedBy),
      controller,
      wants: describeValueTest(controller, def.gatedBy),
    };
  }

  private clashing(a: SettingDef, aTest: ValueTest, b: SettingDef, bTest: ValueTest): boolean {
    return matchesValueTest(a, this.valueOf(a.id), aTest) && matchesValueTest(b, this.valueOf(b.id), bTest);
  }

  /**
   * The warning for a bad pairing, or null while the pairing is not in effect. Both settings have to be in
   * their named states, so changing either one clears it.
   *
   * Declared on one half of the pair and read from both, because whoever flips the other half would otherwise
   * get no warning at all - and which half carries the declaration is an accident of where the upstream files
   * happened to document it.
   */
  conflictOf(def: SettingDef): { other: SettingDef; note: string } | null {
    const own = def.conflictsWith;
    const declared = own ? SETTINGS.find((s) => s.id === own.id) : undefined;
    if (own && declared && this.clashing(def, own.self, declared, own.other)) {
      return { other: declared, note: own.note };
    }

    const from = SETTINGS.find((s) => s.conflictsWith?.id === def.id);
    const back = from?.conflictsWith;
    if (from && back && this.clashing(from, back.self, def, back.other)) return { other: from, note: back.note };
    return null;
  }

  isModified(id: string): boolean {
    return id in this.overrides && this.overrides[id] !== this.baselineOf(id);
  }

  set(id: string, value: string): void {
    if (value === this.baselineOf(id)) {
      const { [id]: _dropped, ...rest } = this.overrides;
      this.overrides = rest;
      return;
    }
    this.overrides = { ...this.overrides, [id]: value };
    this.scheduleAutosave();
  }

  revert(id: string): void {
    const { [id]: _dropped, ...rest } = this.overrides;
    this.overrides = rest;
    this.scheduleAutosave();
  }

  revertAll(): void {
    // Pinned values are ZAX policy rather than a user edit, so reverting restores them instead of dropping them.
    this.overrides = this.managedOverrides();
    this.mods = this.modsBaseline;
    this.scheduleAutosave();
  }

  /**
   * The mod order counts as one unsaved change however much of it moved: it is one file, written whole, and
   * counting rows would report a single drag past two neighbours as two edits.
   */
  get modifiedCount(): number {
    return Object.keys(this.overrides).length + (this.modsChanged ? 1 : 0);
  }

  get modsChanged(): boolean {
    const now = this.mods;
    const was = this.modsBaseline;
    if (now.length !== was.length) return true;
    return now.some((mod, i) => mod.name !== was[i]?.name || mod.enabled !== was[i]?.enabled);
  }

  /** Unsaved edits among the installed mods' settings, for the dot on their own tab. */
  get modSettingsChanged(): boolean {
    return [...this.modById.keys()].some((id) => this.isModified(id));
  }

  /** The Mods view's own mark: the order, or any of the installed mods' settings, holds an unsaved edit. */
  get modsViewChanged(): boolean {
    return this.modsChanged || this.modSettingsChanged;
  }

  /** Turns a mod on or off, which is the line being written or commented out in place. */
  toggleMod(name: string): void {
    this.mods = this.mods.map((mod) => (mod.name === name ? { ...mod, enabled: !mod.enabled } : mod));
    this.scheduleAutosave();
  }

  /** Moves a mod one place, `by` being negative to load it earlier. Refuses to move one off either end. */
  moveMod(name: string, by: number): void {
    const from = this.mods.findIndex((mod) => mod.name === name);
    const to = from + by;
    if (from === -1 || to < 0 || to >= this.mods.length) return;
    const next = [...this.mods];
    next.splice(to, 0, ...next.splice(from, 1));
    this.mods = next;
    this.scheduleAutosave();
  }

  /**
   * Drops an entry naming something no longer in the folder. Only offered for those: an entry whose mod is
   * still there would come straight back on the next read, from the folder listing rather than the file.
   */
  forgetMod(name: string): void {
    this.mods = this.mods.filter((mod) => mod.name !== name);
    this.scheduleAutosave();
  }

  /** Reads what the feeds offer this install. On demand rather than at startup - it costs the network. */
  async loadModOffers(): Promise<void> {
    const install = this.install;
    if (!install) {
      this.modListing = null;
      return;
    }
    await this.run("Reading the mod feeds", async () => {
      this.modListing = await backend.availableMods(install);
      return null;
    });
  }

  /**
   * The one refusal every mod flow starts with: nothing runs over unsaved edits. Broader than the files a
   * plan touches, on purpose - the flow rewrites the order file and may merge inis, and "save or revert
   * first" is a clearer contract than a per-file argument about which edit was safe.
   */
  private modFlowRefusal(): Notice | null {
    if (this.modsChanged || this.modifiedCount > 0) {
      return { kind: "problem", text: "There are unsaved edits - save or revert them before changing mods." };
    }
    return null;
  }

  /** Downloads and verifies a release, then holds its resolved plan up for the user's word. */
  async prepareMod(offer: ModOffer): Promise<void> {
    const install = this.install;
    if (!install) return;
    const refusal = this.modFlowRefusal();
    if (refusal) {
      this.notice = refusal;
      return;
    }
    await this.run(`Preparing ${offer.name} ${offer.version}`, async () => {
      const plan = await backend.planMod(install, offer.id);
      this.modPlan = { offer, plan };
      return null;
    });
  }

  /** The confirmed plan is executed; the plan dialog closes either way, the working directory persists. */
  async confirmModInstall(): Promise<void> {
    const held = this.modPlan;
    const install = this.install;
    this.modPlan = null;
    if (!held || !install) return;
    await this.run(`Installing ${held.offer.name} ${held.offer.version}`, async () => {
      const outcome = await backend.installMod(install, held.offer.id);
      await this.readInstall();
      await this.loadModOffers();
      const conflicts =
        outcome.conflicts.length > 0
          ? ` ${outcome.conflicts.length} setting(s) you had changed were kept over the release's new defaults.`
          : "";
      return { kind: "done", text: `${held.offer.name} ${outcome.version} installed.${conflicts}` };
    });
  }

  /** Cancelling the plan keeps the working directory, so a later attempt resumes rather than re-downloads. */
  dismissModPlan(): void {
    this.modPlan = null;
  }

  async removeMod(offer: ModOffer): Promise<void> {
    const install = this.install;
    if (!install) return;
    const refusal = this.modFlowRefusal();
    if (refusal) {
      this.notice = refusal;
      return;
    }
    await this.run(`Removing ${offer.name}`, async () => {
      await backend.removeMod(install, offer.id);
      await this.readInstall();
      await this.loadModOffers();
      return { kind: "done", text: `${offer.name} removed. Copies are in the backup folder.` };
    });
  }

  /** Opens one of an installed mod's own inis - the route to the sections its schema does not cover. */
  async openModIni(modId: string, file: string): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run("Opening the file", async () => {
      await backend.openModFile(install, modId, file);
      return null;
    });
  }

  /** Unwinds an install that never finished, from the working directory's copies. */
  async restoreMod(offer: ModOffer): Promise<void> {
    const install = this.install;
    if (!install) return;
    const refusal = this.modFlowRefusal();
    if (refusal) {
      this.notice = refusal;
      return;
    }
    await this.run(`Restoring before ${offer.name}`, async () => {
      await backend.restoreMod(install, offer.id);
      await this.readInstall();
      await this.loadModOffers();
      return { kind: "done", text: `The install is back to what it was before ${offer.name}.` };
    });
  }

  /**
   * Settings matching the query, across every file and tab rather than only the one on screen - the point of
   * searching is to find a setting whose tab you do not know. Each carries its address, since the row has been
   * lifted out of the tab that would otherwise say where it lives.
   */
  get results(): ReadonlyArray<{ def: SettingDef; place: Place; where: string }> {
    const q = this.query.trim().toLowerCase();
    // Held against the query it was computed for. This is a plain getter, so every read re-runs it, and the
    // tab that draws the results reads it once per row - 164 full passes over the catalog to draw one list,
    // repeated on every keystroke. The field is deliberately not reactive: `query` above is what the
    // component depends on, and making the cache itself a rune would loop.
    if (this.cachedResults?.query === q) return this.cachedResults.rows;

    // No query lists everything: the tab this feeds is the whole catalog in one place, and searching narrows
    // it rather than being the only way to see anything at all.
    // Every word has to appear somewhere, not the phrase in one field: a label carries no frame or tab words
    // any more, so "interface bar width" is spread across the address and the label and matches neither alone.
    const terms = q === "" ? [] : q.split(/\s+/);
    const rows = SEARCHABLE.filter((one) => terms.every((t) => one.hay.includes(t))).map(({ def, place, where }) => ({
      def,
      place,
      where,
    }));
    this.cachedResults = { query: q, rows };
    return rows;
  }

  /**
   * Install is the one settings tab holding nothing from the catalog - its fields belong to the install, not to
   * a config file - so search cannot reach it the way it reaches every other tab, and "wine" would report
   * nothing while the tab sits in plain view. The Wine terms only count where Wine exists.
   */
  get installMatches(): boolean {
    const q = this.query.trim().toLowerCase();
    if (q === "") return false;
    const hay = `install alias name folder path${this.wineAvailable ? " wine wineprefix winedebug prefix launch" : ""}`;
    return q.split(/\s+/).every((t) => hay.includes(t));
  }

  /**
   * Opens the install tab with its alias field focused. One route for every way of asking to rename - the
   * games list's context menu, F2 - so a second entry point cannot drift into editing somewhere else.
   */
  /** Opens the tab that lists every setting, with its filter focused. */
  searchSettings(): void {
    this.settingsTab = "all";
    this.searchRequest += 1;
  }

  renameSelected(): void {
    if (!this.install) return;
    this.settingsTab = "install";
    this.query = "";
    this.aliasRequest += 1;
  }

  /** Jumps to where a result lives and clears the search, so the row keeps its surrounding group. */
  goTo(place: Place): void {
    this.settingsTab = place.file;
    this.fileTab = { ...this.fileTab, [place.file]: place.tab };
    this.query = "";
  }

  /** Unsaved edits belonging to one config file, for the dot on its settings tab. */
  modifiedInFile(file: string): number {
    return SETTINGS.filter((s) => s.file === file && this.isModified(s.id)).length;
  }

  /**
   * The view's own mark, on the same footing as `modsChanged`. Shares `isModified` with the per-file dots
   * below it rather than counting override keys, so the two cannot come to disagree about what an edit is: a
   * mark up here with none under it would only send the user looking for a tab that does not carry one.
   */
  get settingsChanged(): boolean {
    return SETTINGS.some((s) => this.isModified(s.id));
  }

  actionById(id: string): Action | undefined {
    return ACTIONS.find((a) => a.id === id);
  }

  /** Every action offered in one place, so a panel does not carry its own list of what to show. */
  actionsIn(group: ActionGroup): readonly Action[] {
    return ACTIONS.filter((a) => a.group === group);
  }

  get install(): Install | undefined {
    return this.installs.find((g) => g.path === this.selectedInstall);
  }

  /**
   * Wine only exists off Windows, matching the previous implementation, which hid the whole tab there. The
   * machine that decides is the one the files are on, which the platform reports.
   */
  get wineAvailable(): boolean {
    return this.machine?.os !== "windows";
  }

  /** Where ZAX keeps its own files, for the panel that shows and empties them. Empty until startup finishes. */
  get paths(): { backup: string; debug: string; packages: string; log: string } {
    return {
      backup: this.machine?.backupDirectory ?? "",
      debug: this.machine?.debugDirectory ?? "",
      packages: this.machine?.packageDirectory ?? "",
      log: this.machine?.logFile ?? "",
    };
  }

  // ---- Operations that reach the machine ----------------------------------------------------------------

  async selectInstall(path: string): Promise<void> {
    if (path === this.selectedInstall) return;
    this.selectedInstall = path;
    await this.readInstall();
  }

  async removeInstall(path: string): Promise<void> {
    this.installs = removeInstall(this.installs, path);
    // Dropping the selected install would leave every settings view bound to something no longer listed.
    if (this.selectedInstall === path) {
      this.selectedInstall = this.installs[0]?.path ?? "";
      await this.readInstall();
    }
    await this.persist();
  }

  /** Renames an install, or restores the type's own name when given nothing. */
  async setAlias(path: string, name: string): Promise<void> {
    this.installs = setAlias(this.installs, path, name);
    await this.persist();
  }

  async setWine(path: string, wine: WineConfig): Promise<void> {
    this.installs = withWine(this.installs, path, wine);
    await this.persist();
  }

  async setTheme(theme: Theme): Promise<void> {
    this.theme = theme;
    await this.persist();
  }

  /** Turning it on writes what is already pending, so the setting and the files agree immediately. */
  async setAutosave(on: boolean): Promise<void> {
    this.autosave = on;
    // A write scheduled by the last edit belongs to the setting that was on when it happened: turning autosave
    // off inside that window means the user does not want it written.
    if (!on) this.cancelAutosave();
    await this.persist();
    if (on && this.modifiedCount > 0) await this.save();
  }

  /*
    Autosave coalesces rather than writing per change: dragging a slider emits a change per pixel, and each
    write rewrites a config file and takes a backup copy. A pending save also has to wait for one already
    running - `run` drops a second call while busy, which would silently lose the newest edit.
  */
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null;

  private scheduleAutosave(): void {
    if (!this.autosave) return;
    if (this.autosaveTimer !== null) clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null;
      void this.autosaveNow();
    }, AUTOSAVE_DELAY);
  }

  private cancelAutosave(): void {
    if (this.autosaveTimer === null) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
  }

  private async autosaveNow(): Promise<void> {
    // Checked again here rather than only at schedule time: a rescheduled write can outlive the setting.
    if (!this.autosave) return;
    if (this.busy !== null) {
      this.scheduleAutosave();
      return;
    }
    if (this.modifiedCount > 0 || this.pendingChanges().length > 0) await this.save();
  }

  /** Opens the shell's directory picker and adds what comes back. Cancelling adds nothing and says nothing. */
  async browseForInstall(): Promise<void> {
    const chosen = await backend.chooseFolder();
    if (chosen !== null) await this.addInstall(chosen);
  }

  /** Whether the selected install has this config file at all. Unknown until the first read finishes. */
  hasFile(file: string): boolean {
    return this.contents[file] !== undefined;
  }

  /** Adds a directory the user pointed at, refusing one that does not hold a game. */
  async addInstall(path: string): Promise<void> {
    await this.run("Adding the install", async () => {
      const trimmed = path.trim();
      if (trimmed === "") return null;
      const type = await backend.identifyInstall(trimmed);
      if (type === null) return { kind: "problem", text: `${trimmed} does not hold a Fallout 2 install.` };
      const result = addInstall(this.installs, { path: trimmed, type });
      if (!result.ok) return { kind: "problem", text: result.reason };
      this.installs = result.installs;
      await this.persist();
      if (this.selectedInstall === "") await this.selectInstall(trimmed);
      return { kind: "done", text: `Added ${trimmed}.` };
    });
  }

  async scan(): Promise<void> {
    await this.run("Scanning", async () => {
      const found = await backend.scanForInstalls(this.installs);
      if (found.length === 0) return { kind: "done", text: "Nothing found in the usual places." };
      this.installs = [...this.installs, ...found].sort((a, b) => a.path.localeCompare(b.path));
      await this.persist();
      if (this.selectedInstall === "") await this.selectInstall(found[0]!.path);
      return { kind: "done", text: `Found ${found.length === 1 ? "one install" : `${found.length} installs`}.` };
    });
  }

  /** Values to write, as the keys they write. The queued edits unless another set is named. */
  private pendingChanges(values: Record<string, string> = this.overrides): ConfigChange[] {
    const out: ConfigChange[] = [];
    for (const [id, value] of Object.entries(values)) {
      const def = SETTINGS.find((s) => s.id === id) ?? this.modById.get(id) ?? this.discovered.find((s) => s.id === id);
      if (def) out.push({ file: def.file, section: def.section, key: def.key, value });
    }
    return out;
  }

  async save(): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run("Saving", async () => {
      // The mod order goes first, and a refusal there stops the save before anything has been written: both
      // writes can be refused, and only this order lets one of the two refusals mean "nothing happened".
      const savedMods = this.modsChanged;
      if (savedMods) {
        const written = await backend.saveMods({
          installPath: install.path,
          original: this.modsText,
          mods: this.mods,
        });
        if (!written.ok) {
          return {
            kind: "problem",
            text: `${MODS_ORDER_PATH} changed on disk since it was read. Nothing was written.`,
          };
        }
        // Straight back off disk, so the file just written is what the next save is measured against rather
        // than the text this one started from - which would refuse the following save as a foreign edit.
        await this.readMods(install);
      }

      const outcome = await backend.saveConfigFiles({
        installPath: install.path,
        original: this.contents,
        changes: this.pendingChanges(),
      });
      if (!outcome.ok) {
        // Rereading would silently drop the edits; the user decides, so the files are left as they are.
        const mods = savedMods ? " The mod order was saved." : "";
        return {
          kind: "problem",
          text: `${outcome.changed.join(" and ")} changed on disk since it was read. Nothing was written.${mods}`,
        };
      }
      await this.readInstall();
      // A save that worked says so by clearing the unsaved chip; only the refusal above is worth a banner.
      return null;
    });
  }

  async play(): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run("Starting the game", async () => {
      await backend.launch(install, this.sfallInstalled);
      return null;
    });
  }

  async checkZaxVersion(): Promise<void> {
    await this.run("Checking for a newer ZAX", async () => {
      this.zaxLatest = (await backend.latestZax()).version;
      return null;
    });
  }

  async checkSfallVersion(): Promise<void> {
    await this.run("Checking for a newer sfall", async () => {
      this.sfallLatest = await backend.latestSfall();
      return null;
    });
  }

  /** Whether the release that was found is newer than what the install has. */
  get sfallOutdated(): boolean {
    if (!this.sfallLatest || this.sfallInstalled === null) return false;
    return compareVersions(this.sfallInstalled, this.sfallLatest.version) < 0;
  }

  /** Versions that can be changed to, read on demand: it is a second request nobody needs until they ask. */
  sfallVersions = $state<readonly string[]>([]);
  /**
   * Whether the list has been asked for and answered. Separate from the list being empty, because a feed that
   * answered with nothing is not the same as one that has not answered yet - and with only the array to go on,
   * the dialog said "Reading the list..." for ever after a mirror returned an empty page.
   */
  sfallVersionsRead = $state(false);

  async loadSfallVersions(): Promise<void> {
    if (this.sfallVersions.length > 0) return;
    await this.run("Reading the sfall versions", async () => {
      this.sfallVersions = await backend.listSfallVersions();
      this.sfallVersionsRead = true;
      if (this.sfallVersions.length === 0) {
        return { kind: "problem", text: "The release listing named no versions. It may be worth trying again." };
      }
      return null;
    });
  }

  /**
   * Puts a given version of sfall into the install, whichever direction that is. Installing, updating and going
   * back are one operation: each downloads that version, merges the settings, backs up what it replaces and
   * copies it over. The labels differ, so the caller says what it was doing.
   */
  async changeSfall(version: string, doing = "Updating sfall"): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run(doing, async () => {
      const result = await backend.updateSfall(install, version);
      await this.readInstall();
      const kept = result.backup === null ? "" : ` Replaced files are in ${result.backup}.`;
      // Both sides changed these, and the user's won. Nothing is broken, but it is the one part of a merge
      // worth looking at, so it is named rather than counted.
      const clashed = result.conflicts.length
        ? ` Kept your value for ${result.conflicts.map((c) => c.key).join(", ")}.`
        : "";
      const count = result.removed.length;
      const gone = count ? ` Dropped ${count} setting${count === 1 ? "" : "s"} this release does not have.` : "";
      return { kind: "done", text: `sfall is now ${result.version}.${kept}${clashed}${gone}` };
    });
  }

  async updateSfall(): Promise<void> {
    const release = this.sfallLatest;
    if (release) await this.changeSfall(release.version);
  }

  /** Installs sfall into an install that has none, which is the same operation with nothing to merge. */
  async installSfall(): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run("Installing sfall", async () => {
      const release = await backend.latestSfall();
      this.sfallLatest = release;
      const result = await backend.updateSfall(install, release.version);
      await this.readInstall();
      return { kind: "done", text: `sfall ${result.version} is installed.` };
    });
  }

  async saveSlots(): Promise<readonly string[]> {
    const install = this.install;
    return install ? backend.listSaves(install) : [];
  }

  async createDebugPackage(saves: readonly string[]): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run("Creating the debug package", async () => {
      const result = await backend.createDebugPackage(install, saves);
      // Opened where it was written, as the previous implementation did: the next step is attaching the file to
      // a report, and a path in a notice still leaves the user to go find it. The archive is what was asked
      // for, so a machine that cannot open a directory reports the path rather than reporting a failure.
      try {
        await backend.open("debug");
      } catch {
        // Nothing to add: the notice below already says where the file is.
      }
      return { kind: "done", text: `Wrote ${result.path} - ${result.contents.length} files.` };
    });
  }

  async open(target: OpenTarget): Promise<void> {
    await this.run("Opening", async () => {
      await backend.open(target);
      return null;
    });
  }

  async wipe(which: OwnDirectory): Promise<void> {
    await this.run("Emptying the directory", async () => {
      await backend.wipe(which);
      return { kind: "done", text: `Emptied the ${which} directory.` };
    });
  }
}

export const store = new Store();
export { SETTINGS, isPreview };
