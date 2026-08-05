import {
  IniDocument,
  addInstall,
  backupDirectory,
  compareVersions,
  debugDirectory,
  describeValueTest,
  identifyInstall,
  isApplied,
  latestZax,
  loadConfigFiles,
  loadState,
  logFile,
  matchesValueTest,
  removeInstall,
  saveConfigFiles,
  saveState,
  scanForInstalls,
  withWine,
  type Action,
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
  SETTINGS,
  createDebugPackage,
  describePlace,
  hiddenIds,
  installedSfallVersion,
  latestSfall,
  listSaves,
  placesById,
  planLaunch,
  updateSfall,
  type Place,
  type SfallRelease,
} from "@zax/fallout2";
import { isPreview, platform } from "./host.js";

// Built once: the layout does not change at runtime, and every search result needs a lookup in it.
const PLACES = placesById();
const HIDDEN = hiddenIds();

const CURATED = new Map(SETTINGS.map((s) => [`${s.file}|${s.section}|${s.key}`.toLowerCase(), s]));

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

/** The two the previous implementation had at the top level, in its order. */
export type View = "settings" | "trouble";

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
  /** Which Settings sub-tab: a config file, or "wine". */
  settingsTab = $state<SettingsTab>("fallout2.cfg");
  /** The selected tab within each file, kept per file so switching files does not reset the other's place. */
  fileTab = $state<Record<string, string>>({});
  query = $state("");
  installs = $state<readonly Install[]>([]);
  selectedInstall = $state<string>("");
  theme = $state<Theme>("system");
  overrides = $state<Record<string, string>>({});

  /** Contents of the selected install's config files, exactly as they were read. */
  contents = $state<ConfigFileContents>({});
  /** False until the first read of the state file and the selected install's config files has finished. */
  loaded = $state(false);
  /** The operation in progress, for disabling the controls that would start a second one. */
  busy = $state<string | null>(null);
  notice = $state<Notice | null>(null);

  sfallInstalled = $state<string | null>(null);
  sfallLatest = $state<SfallRelease | null>(null);
  zaxLatest = $state<string | null>(null);

  /**
   * Installs the state file lists but that could not be read. Held so saving the file writes them back rather
   * than turning a drive being offline for one session into losing the entry.
   */
  private unavailable: readonly StoredInstall[] = [];

  /**
   * The values on disk, and every key the files actually hold. Computed when an install is read rather than
   * derived from `contents`: this is three file parses and a pass over 166 settings, and a derivation would
   * repeat it on every access from a plain function call.
   */
  private baseline: Record<string, string | undefined> = $state({});
  private rawBaseline: Record<string, string | undefined> = $state({});
  discovered = $state<SettingDef[]>([]);

  private index(): void {
    const documents = Object.fromEntries(CONFIG_FILES.map((f) => [f, IniDocument.parse(this.contents[f] ?? "")]));
    const valueOf = (s: SettingDef) => documents[s.file]?.get(s.section, s.key);
    this.discovered = discover(documents);
    this.baseline = Object.fromEntries(SETTINGS.map((s) => [s.id, valueOf(s)]));
    this.rawBaseline = Object.fromEntries(this.discovered.map((s) => [s.id, valueOf(s)]));
  }

  /**
   * Values ZAX pins regardless of what the file says. UAC_AWARE=1 makes the high-resolution patch read its
   * settings from roaming appdata instead of the game folder, so leaving it on means editing an ini the patch
   * never reads. They start as pending changes so the user sees them rather than having them applied invisibly.
   */
  private managedOverrides(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const s of SETTINGS) {
      if (s.managed && this.baselineOf(s.id) !== s.managed.value) out[s.id] = s.managed.value;
    }
    return out;
  }

  /** Reads the state file, then the selected install's config files. Runs once, at startup. */
  async start(): Promise<void> {
    const { state, problem } = await loadState(platform);
    this.installs = state.installs;
    this.unavailable = state.unavailable;
    this.theme = state.theme;
    this.selectedInstall = state.installs[0]?.path ?? "";
    if (problem) this.notice = { kind: "problem", text: problem };
    await this.readInstall();
    this.loaded = true;
  }

  /** Rereads the selected install: its config files and which sfall it has. */
  private async readInstall(): Promise<void> {
    const install = this.install;
    this.sfallInstalled = null;
    if (!install) {
      this.contents = {};
      this.index();
      this.overrides = {};
      return;
    }
    this.contents = await loadConfigFiles(platform, install.path, [...CONFIG_FILES]);
    this.index();
    this.overrides = this.managedOverrides();
    this.sfallInstalled = await installedSfallVersion(platform, install);
  }

  /** Runs one outward-facing operation, reporting whatever it fails with rather than swallowing it. */
  private async run(what: string, work: () => Promise<Notice | null>): Promise<void> {
    if (this.busy !== null) return;
    this.busy = what;
    this.notice = null;
    try {
      this.notice = await work();
    } catch (error) {
      this.notice = { kind: "problem", text: `${what} failed: ${(error as Error).message}` };
    } finally {
      this.busy = null;
    }
  }

  private async persist(): Promise<void> {
    await saveState(platform, { installs: this.installs, unavailable: this.unavailable, theme: this.theme });
  }

  /** Writes every target of an action in one step, so it lands as a single user-visible change. */
  applyAction(action: Action): void {
    const next = { ...this.overrides };
    for (const [id, want] of Object.entries(action.targets)) {
      if (want === this.baselineOf(id)) delete next[id];
      else next[id] = want;
    }
    this.overrides = next;
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
    return SETTINGS.find((s) => s.id === id);
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
    const controller = SETTINGS.find((s) => s.id === def.gatedBy!.id);
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
  }

  revert(id: string): void {
    const { [id]: _dropped, ...rest } = this.overrides;
    this.overrides = rest;
  }

  revertAll(): void {
    // Pinned values are ZAX policy rather than a user edit, so reverting restores them instead of dropping them.
    this.overrides = this.managedOverrides();
  }

  get modifiedCount(): number {
    return Object.keys(this.overrides).length;
  }

  /**
   * Settings matching the query, across every file and tab rather than only the one on screen - the point of
   * searching is to find a setting whose tab you do not know. Each carries its address, since the row has been
   * lifted out of the tab that would otherwise say where it lives.
   */
  get results(): Array<{ def: SettingDef; place: Place; where: string }> {
    const q = this.query.trim().toLowerCase();
    if (q === "") return [];
    // Every word has to appear somewhere, not the phrase in one field: a label carries no frame or tab words
    // any more, so "interface bar width" is spread across the address and the label and matches neither alone.
    const terms = q.split(/\s+/);
    const out: Array<{ def: SettingDef; place: Place; where: string }> = [];
    for (const def of SETTINGS) {
      const place = PLACES.get(def.id);
      // A pinned value is drawn even where the layout hides it, so it stays findable for the same reason.
      if (!place || (HIDDEN.has(def.id) && !def.managed)) continue;
      const where = describePlace(place);
      const hay = `${def.label} ${def.key} ${def.section} ${def.file} ${def.help ?? ""} ${where}`.toLowerCase();
      if (terms.every((t) => hay.includes(t))) out.push({ def, place, where });
    }
    return out;
  }

  /**
   * Wine is the one settings tab holding nothing from the catalog - its two fields belong to the install, not
   * to a config file - so search cannot reach it the way it reaches every other tab, and "wine" would report
   * nothing while the tab sits in plain view.
   */
  get wineMatches(): boolean {
    const q = this.query.trim().toLowerCase();
    if (q === "" || !this.wineAvailable) return false;
    const hay = "wine wineprefix winedebug prefix launch";
    return q.split(/\s+/).every((t) => hay.includes(t));
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

  actionById(id: string): Action | undefined {
    return ACTIONS.find((a) => a.id === id);
  }

  get install(): Install | undefined {
    return this.installs.find((g) => g.path === this.selectedInstall);
  }

  /**
   * Wine only exists off Windows, matching the previous implementation, which hid the whole tab there. The
   * machine that decides is the one the files are on, which the platform reports.
   */
  get wineAvailable(): boolean {
    return platform.os !== "windows";
  }

  get paths(): { backup: string; debug: string; log: string } {
    return { backup: backupDirectory(platform), debug: debugDirectory(platform), log: logFile(platform) };
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

  async setWine(path: string, wine: WineConfig): Promise<void> {
    this.installs = withWine(this.installs, path, wine);
    await this.persist();
  }

  async setTheme(theme: Theme): Promise<void> {
    this.theme = theme;
    await this.persist();
  }

  /** Adds a directory the user pointed at, refusing one that does not hold a game. */
  async addInstall(path: string): Promise<void> {
    await this.run("Adding the install", async () => {
      const trimmed = path.trim();
      if (trimmed === "") return null;
      const type = await identifyInstall(platform, trimmed);
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
      const found = await scanForInstalls(platform, this.installs);
      if (found.length === 0) return { kind: "done", text: "Nothing found in the usual places." };
      this.installs = [...this.installs, ...found].sort((a, b) => a.path.localeCompare(b.path));
      await this.persist();
      if (this.selectedInstall === "") await this.selectInstall(found[0]!.path);
      return { kind: "done", text: `Found ${found.length === 1 ? "one install" : `${found.length} installs`}.` };
    });
  }

  /** Every pending edit, as the keys they write. */
  private pendingChanges(): ConfigChange[] {
    const out: ConfigChange[] = [];
    for (const [id, value] of Object.entries(this.overrides)) {
      const def = SETTINGS.find((s) => s.id === id) ?? this.discovered.find((s) => s.id === id);
      if (def) out.push({ file: def.file, section: def.section, key: def.key, value });
    }
    return out;
  }

  async save(): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run("Saving", async () => {
      const outcome = await saveConfigFiles(platform, {
        installPath: install.path,
        original: this.contents,
        changes: this.pendingChanges(),
      });
      if (!outcome.ok) {
        // Rereading would silently drop the edits; the user decides, so the files are left as they are.
        return {
          kind: "problem",
          text: `${outcome.changed.join(" and ")} changed on disk since it was read. Nothing was written.`,
        };
      }
      await this.readInstall();
      if (outcome.files.length === 0) return null;
      return { kind: "done", text: `Saved ${outcome.files.join(", ")}. Previous copies are in ${outcome.backup}.` };
    });
  }

  async play(): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run("Starting the game", async () => {
      const plan = planLaunch(platform.os, install, this.sfallInstalled);
      await platform.process.launch(plan.program, plan.args, { cwd: plan.cwd, env: plan.env });
      return null;
    });
  }

  async checkZaxVersion(): Promise<void> {
    await this.run("Checking for a newer ZAX", async () => {
      this.zaxLatest = (await latestZax(platform)).version;
      return null;
    });
  }

  async checkSfallVersion(): Promise<void> {
    await this.run("Checking for a newer sfall", async () => {
      this.sfallLatest = await latestSfall(platform);
      return null;
    });
  }

  /** Whether the release that was found is newer than what the install has. */
  get sfallOutdated(): boolean {
    if (!this.sfallLatest || this.sfallInstalled === null) return false;
    return compareVersions(this.sfallInstalled, this.sfallLatest.version) < 0;
  }

  async updateSfall(): Promise<void> {
    const install = this.install;
    const release = this.sfallLatest;
    if (!install || !release) return;
    await this.run("Updating sfall", async () => {
      const result = await updateSfall(platform, install, release);
      await this.readInstall();
      const kept = result.backup === null ? "" : ` Replaced files are in ${result.backup}.`;
      return { kind: "done", text: `sfall is now ${result.version}.${kept}` };
    });
  }

  async saveSlots(): Promise<string[]> {
    const install = this.install;
    return install ? listSaves(platform, install) : [];
  }

  async createDebugPackage(saves: readonly string[]): Promise<void> {
    const install = this.install;
    if (!install) return;
    await this.run("Creating the debug package", async () => {
      const result = await createDebugPackage(platform, install, saves);
      return { kind: "done", text: `Wrote ${result.path} - ${result.contents.length} files.` };
    });
  }

  async open(path: string): Promise<void> {
    await this.run("Opening", async () => {
      await platform.process.open(path);
      return null;
    });
  }

  /** Empties one of ZAX's own directories. Recreated straight away, so the path stays valid. */
  async wipe(path: string): Promise<void> {
    await this.run("Emptying the directory", async () => {
      await platform.fs.remove(path);
      await platform.fs.mkdir(path);
      return { kind: "done", text: `Emptied ${path}.` };
    });
  }
}

export const store = new Store();
export { SETTINGS, isPreview };
