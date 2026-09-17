/**
 * What the interface draws, and what it asks for.
 *
 * The state and every rule applied to it live on the other side of the command boundary: an install's
 * settings as read and as edited, its mod order, the list of installs, what has been published. Each
 * command answers with the view as it now stands, and this lays that answer over the view it holds. What
 * stays here is what only the window has - which tab is open, which dialog is up, the sentence at the top,
 * the operation the controls are waiting on.
 */

import { commands } from "./commands.js";
import { onProgress } from "./invoke.js";
import { VERSION } from "./version.js";

import type { Action } from "./bindings/Action";
import type { ActionGroup } from "./bindings/ActionGroup";
import type { AddressView } from "./bindings/AddressView";
import type { AppView } from "./bindings/AppView";
import type { BuildPick } from "./bindings/BuildPick";
import type { CachedBuild } from "./bindings/CachedBuild";
import type { CatalogView } from "./bindings/CatalogView";
import type { ChoiceView } from "./bindings/ChoiceView";
import type { EngineListing } from "./bindings/EngineListing";
import type { EngineRelease } from "./bindings/EngineRelease";
import type { GameType } from "./bindings/GameType";
import type { GameTypeView } from "./bindings/GameTypeView";
import type { GroupView } from "./bindings/GroupView";
import type { Install } from "./bindings/Install";
import type { InstallPlan } from "./bindings/InstallPlan";
import type { InstalledEngine } from "./bindings/InstalledEngine";
import type { LayoutFile } from "./bindings/LayoutFile";
import type { Mod } from "./bindings/Mod";
import type { ModListing } from "./bindings/ModListing";
import type { ModOffer } from "./bindings/ModOffer";
import type { ModSettingsGroup } from "./bindings/ModSettingsGroup";
import type { OpenTarget } from "./bindings/OpenTarget";
import type { OperationProgress } from "./bindings/OperationProgress";
import type { OrderEdit } from "./bindings/OrderEdit";
import type { OrderFormat } from "./bindings/OrderFormat";
import type { OrderSwap } from "./bindings/OrderSwap";
import type { OwnDirectory } from "./bindings/OwnDirectory";
import type { ReadingView } from "./bindings/ReadingView";
import type { RowView } from "./bindings/RowView";
import type { SearchResult } from "./bindings/SearchResult";
import type { SettingDef } from "./bindings/SettingDef";
import type { SettingEdit } from "./bindings/SettingEdit";
import type { SfallRelease } from "./bindings/SfallRelease";
import type { Theme } from "./bindings/Theme";
import type { WineConfig } from "./bindings/WineConfig";

/**
 * Runs a check for its effect alone. These reach the network on ZAX's own initiative rather than on a click,
 * so the honest report of a failure is the field staying as it was - what every view renders before anyone
 * has asked.
 */
async function quietly(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch {
    // Left unchecked. The view's own Check button is what reports why, when someone asks for the answer.
  }
}

/*
  Long enough that a slider drag or a series of quick edits lands as one write, short enough that a user who
  changed one thing and looked away sees it saved. Each save rewrites a config file and copies the old one.
*/
const AUTOSAVE_DELAY = 400;

/**
 * What a created install went without, for the line that reports it.
 *
 * Named while there are few enough to read: which files an edition of the archive turned out not to hold is
 * what decides whether the gap matters, and a bare number sends the user looking for a list nothing keeps.
 * Counted past that, because a copy an edition apart renumbers hundreds of 8.3 names at once and a banner
 * carrying every one of them reports nothing at all.
 */
const NAMED_SKIPS = 10;

const skippedText = (names: readonly string[]): string =>
  names.length <= NAMED_SKIPS
    ? `Your archive does not hold ${names.join(", ")}, so ${names.length === 1 ? "it was" : "they were"} skipped.`
    : `Your archive does not hold ${names.length} of the files the mod asked for, so they were skipped.`;

/** The reason a message is the text of whatever was thrown, which is all a refusal carries across the boundary. */
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Troubleshooting's own tab. A fix is one click and a report is a sequence you work through, so they are
 * separated rather than stacked on one screen where neither reads as the whole of it.
 */
type TroubleTab = "report" | "fixes";

/** Which sub-tab of Settings: a group of the layout's, or one of the tabs that belongs to no config file. */
type SettingsTab = string;

/** The tabs the layout does not supply, which stay whatever the install holds. */
const FIXED_SETTINGS_TABS = new Set(["all", "install", "trouble"]);

/** A group of settings tabs to offer, and the reason its rows will not take input, where there is one. */
interface SettingsGroup {
  group: LayoutFile;
  refusal: string | null;
}

/**
 * The sidebar's own tab. Separate from `view` because the column stays put while the main pane changes - the
 * install you are editing is context for every view rather than a destination of its own.
 */
type Panel = "games" | "zax";

/**
 * What the main pane shows. The two are different subjects rather than two tabs of one - settings are keys in
 * config files, mods are what the engine loads - so the switch between them sits above the tab strips both
 * carry, not inside either.
 */
type View = "settings" | "mods" | "engines";

/** The Mods view's own tabs: getting mods, ordering them, and configuring them are three different jobs. */
type ModsTab = "installation" | "order" | "settings" | "fission";

/** Which of a mod row's controls started what is running - one label each, and the button says it. */
type ModAction = "prepare" | "install" | "remove" | "restore";

/** One of ZAX's own places the ZAX pane opens or empties, named the way that pane names them. */
export type OwnPlace = OwnDirectory | "log";

/**
 * Something that happened and the user needs told: a save, a refusal, a failure. `note` is the third case -
 * ZAX did something the user did not ask for and would want to know about, which is neither a completed
 * action nor a fault, and reads as neither.
 */
interface Notice {
  kind: "done" | "problem" | "note";
  text: string;
}

/** A search result as the list draws it: the setting, and the address that locates it. */
interface Found {
  def: SettingDef;
  place: SearchResult;
}

/** An edit waiting to be sent, and whether it has been. */
interface Pending {
  to: SettingEdit["to"];
  sent: boolean;
}

/*
  One object rather than one per view, and long because of it. The split that suggests itself - settings,
  mods, installs, updates - does not hold: almost every method reads the view, `busy`, `progress` and
  `notice`, and the pieces would go on sharing them through something passed between them.
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
  /** Which of the Mods view's tabs is showing. */
  modsTab = $state<ModsTab>("installation");
  /** The selected section sub-tab within each mod's settings, kept per mod as `fileTab` is per file. */
  modSectionTab = $state<Record<string, string>>({});

  /**
   * The catalog, the layout and the fixes, read once. Raw: it arrives whole, is never written into, and a row
   * of the settings tab reads it several times per render.
   */
  catalog = $state.raw<CatalogView | null>(null);
  /**
   * The view as last answered, with the rows of every later answer laid over it. Raw for the same reason:
   * replaced whole on every answer, and read per row.
   */
  private state = $state.raw<AppView | null>(null);

  /** False until the first view has arrived. */
  loaded = $state(false);
  private running = $state<string | null>(null);

  /**
   * The operation in progress, for disabling the controls that would start a second one. The window is told
   * too, from the one place it is set, so a window refusing to close over an operation that has finished - or
   * closing on one that has not - cannot come about through a site that forgot to say.
   */
  get busy(): string | null {
    return this.running;
  }

  set busy(what: string | null) {
    this.running = what;
    // A window that cannot be told has nothing to ask about on close, which is the safe way to be wrong.
    void commands.setBusy(what).catch(() => undefined);
  }
  /**
   * How far that operation has got, when it is the kind that can say. Cleared with the operation, so nothing
   * is left reading 100% after the thing it was measuring has finished.
   */
  progress = $state<OperationProgress | null>(null);
  /**
   * Which mod row the running operation belongs to, when it belongs to one. The top bar says what is
   * happening; this is what lets the button that started it say so rather than only greying out.
   */
  private modOperation = $state<{ id: string; action: ModAction } | null>(null);
  notice = $state<Notice | null>(null);
  /**
   * The note a carry raised, while it is the one showing. Held by identity: the carry being reverted takes its
   * own banner down, and must not take down a save's report that landed on top of it.
   */
  private carryNotice: Notice | null = null;
  /**
   * Set from the moment cancelling is asked for until the operation it was asked of has finished unwinding.
   * The button reads it to stop offering itself twice, and `run` reads it to report what came back as the
   * user's own doing rather than as a failure - which the thrown value cannot say for itself, having crossed
   * a process boundary that leaves only a message behind.
   */
  cancelling = $state(false);

  /**
   * Edits made and not yet reflected in a view, by setting. The control shows these rather than the view's
   * value, which is what keeps a field someone is typing into from being overwritten by the answer to the
   * keystroke before last.
   */
  private pending = $state<Record<string, Pending>>({});

  /**
   * Edits go through here, one after another. Sent together they reach the other side in no particular order,
   * and two edits to one setting would settle on whichever arrived last rather than the one the user left.
   * Only edits: an operation that runs for minutes would otherwise hold every edit made while it ran, and its
   * answer needs no place in line - the revision it carries is what orders it against the rest.
   */
  private queue: Promise<unknown> = Promise.resolve();

  query = $state("");
  /** The settings the query matches, and whether the install tab does - see `setQuery`. */
  private found = $state.raw<{ query: string; results: readonly Found[]; installMatches: boolean }>({
    query: "",
    results: [],
    installMatches: false,
  });

  /** A resolved install plan awaiting the user's word, with the offer it belongs to. */
  modPlan = $state<{
    offer: ModOffer;
    plan: InstallPlan;
    /** The version this plan is for, which is the offer's unless the user picked another. */
    version: string;
  } | null>(null);
  /** The chooser while it is open: the offer whose choice is being made, and what is ticked in it. */
  modParts = $state<{ offer: ModOffer; chosen: readonly string[]; version?: string } | null>(null);
  /** The folders a mod has to be pointed at before it can be planned, while that question is open. */
  modInputs = $state<{
    offer: ModOffer;
    chosen: readonly string[];
    answers: Record<string, string>;
    version?: string;
  } | null>(null);
  /**
   * The versions a row could install instead of the one its button names, once the list has arrived. Held for
   * one row at a time, which is all the dialog shows.
   */
  modVersionPick = $state<{ offer: ModOffer; versions: readonly string[]; read: boolean } | null>(null);
  /** How many reads of the feeds are out. Counted rather than flagged, since two can overlap. */
  private modReads = $state(0);

  /** The engine whose caution or mod order swap is standing in front of a launch, with what it was for. */
  pendingLaunch = $state<{
    engine: EngineListing | null;
    caution: string | null;
    pick: BuildPick | null;
    missed: readonly Mod[];
    swap: OrderSwap | null;
  } | null>(null);
  /** Which engine the held launch is for - null is the game's own executable, which `pendingLaunch` cannot say. */
  private pendingLaunchId: string | null = null;
  /** The engine whose caution is standing in front of a first fetch. */
  pendingFetch = $state<{ engine: EngineListing; published: string | null } | null>(null);

  /** Versions sfall can be changed to, read on demand: it is a second request nobody needs until they ask. */
  sfallVersions = $state<readonly string[]>([]);
  /**
   * Whether the list has been asked for and answered. Separate from the list being empty, because a feed that
   * answered with nothing is not the same as one that has not answered yet.
   */
  sfallVersionsRead = $state(false);

  // ---- The view -------------------------------------------------------------------------------------------

  /**
   * Lays an answer over the view held. Rows an answer sends as changes are merged where they are changes
   * against this view; where they are not, the answer is dropped and the whole view asked for, since laying
   * them over a different view would show rows from two states at once. An answer older than the view held
   * is dropped outright - a slow one landing last would otherwise put a state nobody is in back on screen.
   */
  private async accept(next: AppView): Promise<void> {
    const held = this.state;
    if (held !== null && next.revision <= held.revision) return;
    const reading = next.reading;
    if (reading !== null && reading.since !== null) {
      const base = held?.reading;
      if (held === null || base === null || base === undefined || reading.since !== held.revision) {
        await this.accept(await commands.view());
        return;
      }
      this.publish({
        ...next,
        reading: {
          ...reading,
          since: null,
          rows: { ...base.rows, ...reading.rows },
          discovered: base.discovered,
          modSettings: base.modSettings,
        },
      });
      return;
    }
    this.publish(next);
  }

  /** One view, onto the screen, with everything that follows from it settled in the same step. */
  private publish(next: AppView): void {
    const was = this.state?.reading ?? null;
    this.state = next;
    const reading = next.reading;
    // The carry's banner goes up with the reading that raised it and down with the last carry it counted.
    const carry = reading?.carry ?? null;
    if (carry !== null && carry !== (was?.carry ?? null)) {
      this.carryNotice = { kind: "note", text: carry };
      this.notice = this.carryNotice;
    } else if (carry === null && this.carryNotice !== null) {
      if (this.notice === this.carryNotice) this.notice = null;
      this.carryNotice = null;
    }
    // Off the tab if it just closed under the user - a disabled tab does not move anyone standing on it.
    if (reading?.order.closed != null && this.view === "mods") this.view = "settings";
    // An engine's tab goes when the engine does, and a selection left pointing at it would show nothing.
    if (
      !FIXED_SETTINGS_TABS.has(this.settingsTab) &&
      !this.settingsGroups.some((one) => one.group.id === this.settingsTab)
    ) {
      this.settingsTab = this.catalog?.layout[0]?.id ?? "fallout2.cfg";
    }
  }

  /** Sends a command, and lays the view it answers over the view held. */
  private async change(work: () => Promise<AppView>): Promise<void> {
    await this.accept(await work());
  }

  /** The same, for a command answering something beside the view. */
  private async changeAnd<T>(work: () => Promise<{ view: AppView; answer: T }>): Promise<T> {
    const answered = await work();
    await this.accept(answered.view);
    return answered.answer;
  }

  /** An edit: sent in its place in line, and laid over the view held. */
  private async editWith(work: () => Promise<AppView>): Promise<void> {
    await this.enqueue(async () => this.accept(await work()));
  }

  /**
   * Settles once every command sent so far has been answered and laid over the view - what a caller that has
   * just made an edit waits on before reading what the edit did.
   */
  async idle(): Promise<void> {
    let seen: Promise<unknown> | null = null;
    // Again until nothing new was queued while waiting: an answer can itself queue the whole view.
    while (seen !== this.queue) {
      seen = this.queue;
      await seen;
    }
  }

  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    // The queue carries on past a failure; the caller of that command is the one told about it.
    this.queue = next.catch(() => undefined);
    return next;
  }

  private get reading(): ReadingView | null {
    return this.state?.reading ?? null;
  }

  /** Reads the catalog, the machine's own description and state file, then the selected install. Once, at startup. */
  async start(): Promise<void> {
    // Before anything that could report: a subscription taken out afterwards would miss the first steps of
    // whatever is already running.
    await onProgress((progress) => {
      // Only while something is running. A message that outlives its operation - one still in flight when the
      // call failed - would otherwise sit under an idle interface saying work was going on.
      if (this.busy !== null) this.progress = progress;
    });
    this.catalog ??= await commands.catalog();
    const started = await commands.start(VERSION);
    // A restart is a new sequence of views, numbered from the start again.
    this.state = null;
    this.pending = {};
    await this.accept(started.view);
    if (started.problem) this.notice = { kind: "problem", text: started.problem };
    this.loaded = true;
    await this.search(this.query);
    // Not awaited: the interface is usable without any of it, and each answer lands when it arrives. Awaiting
    // here would hold the whole window open on the slowest of them.
    void this.checkForUpdates();
    if (this.install) void quietly(async () => this.readModListing(false));
  }

  /**
   * Every check the views otherwise wait for a click to make: what ZAX, sfall and the engines have published.
   * Off the `busy` gate on purpose - nobody asked for these, so holding the gate would grey out the controls
   * and refuse the user's first click over a request of ZAX's own making. A failure leaves its field alone:
   * each still has a button behind it that reports properly when it is pressed.
   */
  async checkForUpdates(): Promise<void> {
    await Promise.all([
      quietly(async () => this.change(commands.checkZax)),
      quietly(async () => this.change(commands.checkSfall)),
      // Only the ones this machine could actually install, which is the condition the Check button carries.
      ...this.engines
        .filter((engine) => engine.build !== null)
        .map(async (engine) => quietly(async () => this.change(async () => commands.checkEngine(engine.id)))),
    ]);
  }

  // ---- What the view says ---------------------------------------------------------------------------------

  get installs(): readonly Install[] {
    return this.state?.installs ?? [];
  }

  get selectedInstall(): string {
    return this.state?.selected ?? "";
  }

  get install(): Install | undefined {
    return this.installs.find((one) => one.path === this.selectedInstall);
  }

  get theme(): Theme {
    return this.state?.theme ?? "system";
  }

  /** Whether an edit is written as it is made. On unless the user has turned it off. */
  get autosave(): boolean {
    return this.state?.autosave ?? true;
  }

  get acceptedCautions(): readonly string[] {
    return this.state?.acceptedCautions ?? [];
  }

  /** Every engine ZAX knows, against this machine: which builds the cache holds. */
  get engines(): readonly EngineListing[] {
    return this.state?.engines ?? [];
  }

  get engineLatest(): Readonly<Record<string, EngineRelease>> {
    return this.state?.engineLatest ?? {};
  }

  get sfallLatest(): SfallRelease | null {
    return this.state?.sfallLatest ?? null;
  }

  get zaxLatest(): string | null {
    return this.state?.zaxLatest ?? null;
  }

  get zaxOutdated(): boolean {
    return this.state?.zaxOutdated ?? false;
  }

  get sfallInstalled(): string | null {
    return this.reading?.sfall ?? null;
  }

  get sfallOutdated(): boolean {
    return this.reading?.sfallOutdated ?? false;
  }

  get hiresInstalled(): string | null {
    return this.reading?.hires ?? null;
  }

  /** What is deployed in the selected folder, by engine id. */
  get engineDeployed(): Readonly<Record<string, InstalledEngine>> {
    return this.reading?.engines ?? {};
  }

  engineOutdated(engineId: string): boolean {
    return this.reading?.engineOutdated[engineId] ?? false;
  }

  /** The builds this machine holds for an engine, newest first. */
  engineVersions(engineId: string): readonly CachedBuild[] {
    return this.engines.find((one) => one.id === engineId)?.versions ?? [];
  }

  /**
   * Wine only exists off Windows, matching the previous implementation, which hid the whole tab there. The
   * machine that decides is the one the files are on, which the platform reports.
   */
  get wineAvailable(): boolean {
    return this.state?.machine.os !== "windows";
  }

  /** Where ZAX keeps its own files, for the panel that shows and empties them. Empty until startup finishes. */
  get paths(): { backup: string; debug: string; packages: string; log: string } {
    const machine = this.state?.machine;
    return {
      backup: machine?.backupDirectory ?? "",
      debug: machine?.debugDirectory ?? "",
      packages: machine?.packageDirectory ?? "",
      log: machine?.logFile ?? "",
    };
  }

  /** The keys the files hold that the catalog does not describe. */
  get discovered(): readonly SettingDef[] {
    return this.reading?.discovered ?? [];
  }

  /** The installed mods' settings schemas, rendered with the same per-kind controls the catalog gets. */
  get modSettings(): readonly ModSettingsGroup[] {
    return this.reading?.modSettings ?? [];
  }

  /** Linked settings whose engines have each moved since ZAX wrote, so which value survives is the user's. */
  get settingsChoices(): readonly ChoiceView[] {
    return this.reading?.choices ?? [];
  }

  /** What a kind of install is called, badged and described. */
  gameType(type: GameType): GameTypeView {
    return this.catalog?.gameTypes[type] ?? { name: type, label: type, badge: type };
  }

  /** What to call an install: the user's name for it, or the one its type carries. */
  nameOf(install: Install): string {
    return install.alias ?? this.gameType(install.type).name;
  }

  /** A catalog setting, an installed mod's, or a key only this install's files hold. */
  defOf(id: string): SettingDef | undefined {
    return (
      this.catalogById.get(id) ??
      this.modSettings.flatMap((group) => group.settings.map((one) => one.def)).find((def) => def.id === id) ??
      this.discovered.find((def) => def.id === id)
    );
  }

  private catalogIndex: { from: CatalogView; by: Map<string, SettingDef> } | null = null;

  /** Indexed once per catalog: the settings tab asks for a definition once per row on every render. */
  private get catalogById(): ReadonlyMap<string, SettingDef> {
    const catalog = this.catalog;
    if (catalog === null) return new Map();
    if (this.catalogIndex?.from !== catalog) {
      this.catalogIndex = { from: catalog, by: new Map(catalog.settings.map((def) => [def.id, def])) };
    }
    return this.catalogIndex.by;
  }

  /** What a row draws about a setting, or nothing before an install has been read. */
  row(id: string): RowView | undefined {
    return this.reading?.rows[id];
  }

  /** The address a row on a group's tabs shows, which is the setting's own where that group holds none. */
  address(id: string, group?: string): AddressView | undefined {
    const row = this.row(id);
    if (!row) return undefined;
    return (group !== undefined ? row.groups[group] : undefined) ?? row.groups[row.ownGroup];
  }

  /** The value a control shows: an edit still on its way where there is one, the view's otherwise. */
  valueOf(id: string): string | undefined {
    const pending = this.pending[id]?.to;
    if (pending !== undefined && "raw" in pending) return pending.raw;
    return this.row(id)?.value ?? undefined;
  }

  /** A scale setting's value as its slider shows it, with the same preference for an edit on its way. */
  percentOf(id: string): number | undefined {
    const pending = this.pending[id]?.to;
    if (pending !== undefined && "percent" in pending) return pending.percent;
    return this.row(id)?.percent ?? undefined;
  }

  isModified(id: string): boolean {
    return this.row(id)?.modified ?? false;
  }

  /**
   * The key is not in the config file at all - usually because the installed component predates it. The engine
   * falls back to its own built-in default, so this is not the same as an empty value.
   */
  isAbsent(id: string): boolean {
    return this.row(id)?.absent ?? true;
  }

  /** Whether the selected install has this config file at all. Unknown until the first read finishes. */
  hasFile(file: string): boolean {
    return this.reading?.files.includes(file) ?? false;
  }

  /** The groups of settings tabs to offer, in the layout's order, with why a group's rows refuse input. */
  get settingsGroups(): ReadonlyArray<SettingsGroup> {
    const offered = new Map<string, GroupView>((this.reading?.groups ?? []).map((one) => [one.id, one]));
    const layout = this.catalog?.layout ?? [];
    // Before an install is read there is no answer about engines, so only the game's own groups are offered.
    if (this.reading === null)
      return layout.filter((group) => group.engine === null).map((group) => ({ group, refusal: null }));
    return layout.flatMap((group) => {
      const view = offered.get(group.id);
      return view ? [{ group, refusal: view.refusal }] : [];
    });
  }

  /** Whether a group's rows accept input: the tab is reachable while its settings are not yet writable. */
  groupRefusal(group: string): string | null {
    return this.settingsGroups.find((one) => one.group.id === group)?.refusal ?? null;
  }

  modifiedInGroup(group: string): number {
    return this.reading?.groups.find((one) => one.id === group)?.modified ?? 0;
  }

  get settingsChanged(): boolean {
    return this.reading?.settingsChanged ?? false;
  }

  /** Unsaved edits, the mod order counting once however much of it moved. */
  get modifiedCount(): number {
    return this.reading?.modifiedCount ?? 0;
  }

  get modSettingsChanged(): boolean {
    return this.reading?.modSettingsChanged ?? false;
  }

  get modsChanged(): boolean {
    return this.reading?.order.changed ?? false;
  }

  /** The Mods view's own mark: the order, or any of the installed mods' settings, holds an unsaved edit. */
  get modsViewChanged(): boolean {
    return this.modsChanged || this.modSettingsChanged;
  }

  /** The install's mods, in load order, with whatever the user has changed about it since it was read. */
  get mods(): readonly Mod[] {
    return this.reading?.order.mods ?? [];
  }

  get modsFormat(): OrderFormat {
    return this.reading?.order.format ?? "sfall";
  }

  /** Why the Mods tab is closed, or null when it is open. */
  get modsClosed(): string | null {
    return this.reading?.order.closed ?? null;
  }

  /** The entries loading against ZAX's recommendation, which is both the warning and what a sort moves. */
  get againstRecommendation(): readonly string[] {
    return this.reading?.order.against ?? [];
  }

  /** The entries pointing at nothing - what the row's own Forget drops one at a time. */
  get missingMods(): readonly Mod[] {
    const missing = this.reading?.order.missing ?? [];
    return this.mods.filter((one) => missing.includes(one.name));
  }

  /** The mods folder split by whether Fission would find each entry. */
  get fissionMods(): readonly Mod[] {
    const named = this.reading?.order.fissionMods ?? [];
    return this.mods.filter((one) => named.includes(one.name));
  }

  /** The rest: present, possibly enabled, and invisible to Fission. */
  get fissionMissed(): readonly Mod[] {
    const named = this.reading?.order.fissionMissed ?? [];
    return this.mods.filter((one) => named.includes(one.name));
  }

  /**
   * Fission, when it is deployed in the selected folder. Deployment rather than what the machine's cache holds:
   * one download serves every game folder, so the cache says nothing about this one.
   */
  get fissionEngine(): EngineListing | null {
    return this.engineDeployed.fission === undefined
      ? null
      : (this.engines.find((engine) => engine.id === "fission") ?? null);
  }

  /** What the feeds published against the selected install, or null until both have been read. */
  get modListing(): ModListing | null {
    return this.reading?.modListing ?? null;
  }

  /** Whether an offer's install is this installation itself rather than a folder inside it. */
  createsInPlace(offer: ModOffer): boolean {
    return this.reading?.createsInPlace.includes(offer.id) ?? false;
  }

  /** Whether the Mods tab is waiting on the feeds. Not `busy`: the read a startup begins holds no gate. */
  get readingOffers(): boolean {
    return this.modReads > 0;
  }

  /**
   * Why the rows on screen may not be the folder as it now stands, or null when they are. Only where a listing
   * is drawn - before that the tab says it is reading, and a second sentence about the same wait would be two
   * answers to one question.
   */
  get modsUnsettled(): string | null {
    return this.modListing !== null && this.readingOffers
      ? "Rereading the feeds and this game's folder. The rows below may be a moment out of date."
      : null;
  }

  /** Whether the rows describe the folder as it is now, which is what every action on the tab is aimed at. */
  get modsSettled(): boolean {
    return this.modListing !== null && this.modsUnsettled === null;
  }

  actionById(id: string): Action | undefined {
    return this.catalog?.actions.find((one) => one.id === id);
  }

  /** Every action offered in one place, so a panel does not carry its own list of what to show. */
  actionsIn(group: ActionGroup): readonly Action[] {
    return this.catalog?.actions.filter((one) => one.group === group) ?? [];
  }

  actionApplied(action: Action): boolean {
    return this.reading?.actions.find((one) => one.id === action.id)?.applied ?? false;
  }

  /** How many of an action's targets it would still change. */
  actionPending(action: Action): number {
    return this.reading?.actions.find((one) => one.id === action.id)?.pending ?? 0;
  }

  /** Whether this row's own control is the one running - a button's cue to change its label. */
  modWorking(id: string, action: ModAction): boolean {
    return this.modOperation?.id === id && this.modOperation.action === action;
  }

  /**
   * The step and, where the length is known, the proportion - kept apart rather than joined into one line. The
   * step names a mod, so its length is the mod's and the status bar has to be free to cut it; the proportion is
   * a dozen characters and is the half being watched.
   */
  get progressParts(): { step: string; amount: string | null } | null {
    const at = this.progress;
    if (!at) return null;
    if (at.received === null || at.total === null || at.total === 0) return { step: at.step, amount: null };
    const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);
    return { step: at.step, amount: `${Math.floor((at.received / at.total) * 100)}% of ${mb(at.total)} MB` };
  }

  /**
   * Whether stopping the running operation would reach it. Only the transfer honours a cancel, and the backend
   * says per message which steps those are.
   */
  get cancellable(): boolean {
    return this.busy !== null && this.progress?.cancellable === true && !this.cancelling;
  }

  /**
   * Why a control that acts on the machine is refused, in a sentence, or null when none is. Every such control
   * shows this rather than only grey: a button that will not answer and says nothing reads as broken.
   */
  get busyReason(): string | null {
    if (this.busy === null) return null;
    return this.cancelling ? `Stopping ${this.busy}.` : `${this.busy} is running.`;
  }

  // ---- Search ---------------------------------------------------------------------------------------------

  /** Settings matching the query, across every file and tab, each with the address that locates it. */
  get results(): readonly Found[] {
    return this.found.results;
  }

  /** Whether the install tab answers the query, which holds nothing from the catalog for search to reach. */
  get installMatches(): boolean {
    return this.found.installMatches;
  }

  /** Sets the query and asks what it matches. An answer to a query since replaced is dropped. */
  async setQuery(query: string): Promise<void> {
    this.query = query;
    await this.search(query);
  }

  private async search(query: string): Promise<void> {
    const answer = await commands.search(query);
    if (this.query !== query) return;
    this.found = {
      query,
      results: answer.results.flatMap((place) => {
        const def = this.catalogById.get(place.id);
        return def ? [{ def, place }] : [];
      }),
      installMatches: answer.installMatches,
    };
  }

  /** Opens the tab that lists every setting, with its filter focused. */
  searchSettings(): void {
    this.settingsTab = "all";
    this.searchRequest += 1;
  }

  /**
   * Opens the install tab with its alias field focused. One route for every way of asking to rename - the
   * games list's context menu, F2 - so a second entry point cannot drift into editing somewhere else.
   */
  renameSelected(): void {
    if (!this.install) return;
    this.settingsTab = "install";
    void this.setQuery("");
    this.aliasRequest += 1;
  }

  /** Jumps to where a result lives and clears the search, so the row keeps its surrounding group. */
  goTo(place: SearchResult): void {
    this.settingsTab = place.group;
    this.fileTab = { ...this.fileTab, [place.group]: place.tab };
    void this.setQuery("");
  }

  // ---- Editing --------------------------------------------------------------------------------------------

  set(id: string, value: string): void {
    this.edit(id, { raw: value });
  }

  /** Sets a scale setting from the percentage its slider shows. */
  setPercent(id: string, percent: number): void {
    this.edit(id, { percent });
  }

  /**
   * Queues an edit and sends whatever has piled up by the time the queue reaches it, the latest value for each
   * setting only. A slider drag is a stream of these, and only where it was let go matters.
   */
  private edit(id: string, to: SettingEdit["to"]): void {
    this.pending = { ...this.pending, [id]: { to, sent: false } };
    void this.enqueue(async () => {
      const unsent = Object.entries(this.pending).filter(([, one]) => !one.sent);
      if (unsent.length === 0) return;
      this.pending = Object.fromEntries(
        Object.entries(this.pending).map(([key, one]) => [key, { ...one, sent: true }]),
      );
      try {
        const view = await commands.setSettings(unsent.map(([key, one]) => ({ id: key, to: one.to })));
        // Dropped before the view is laid over: the edits it carries are what the rows now say.
        this.pending = Object.fromEntries(
          Object.entries(this.pending).filter(([key, one]) => !(one.sent && unsent.some(([sent]) => sent === key))),
        );
        await this.accept(view);
      } catch (error) {
        this.pending = {};
        this.notice = { kind: "problem", text: reasonOf(error) };
        await this.accept(await commands.view());
      }
    }).catch(() => undefined);
    this.scheduleAutosave();
  }

  async revert(id: string): Promise<void> {
    await this.revertSettings([id], false);
  }

  async revertAll(): Promise<void> {
    await this.revertSettings([], true);
  }

  private async revertSettings(ids: readonly string[], all: boolean): Promise<void> {
    try {
      await this.editWith(async () => commands.revertSettings(ids, all));
    } catch (error) {
      // The edit is dropped either way, but a base that did not move means the next read reaches the same
      // answer again - which reads as the revert never having worked. Said, and the view read back.
      this.notice = { kind: "problem", text: reasonOf(error) };
      await this.change(commands.view);
    }
    this.scheduleAutosave();
  }

  /** Writes every target of an action in one step, so it lands as a single user-visible change. */
  applyAction(action: Action): void {
    void this.editWith(async () => commands.applyAction(action.id)).catch((error: unknown) => {
      this.notice = { kind: "problem", text: reasonOf(error) };
    });
    this.scheduleAutosave();
  }

  /**
   * Sets everything a row waits on, as ordinary unsaved edits. The notice is not decoration: the settings
   * changed can sit in another tab or another file, where nothing on screen would otherwise show it.
   */
  async satisfyGate(def: SettingDef, group?: string): Promise<void> {
    const set = await this.enqueue(async () => {
      const answered = await commands.satisfyGate(def.id, group ?? null);
      await this.accept(answered.view);
      return answered.answer;
    });
    const first = set[0];
    if (!first) return;
    this.notice =
      set.length === 1
        ? { kind: "done", text: `Set ${first.label} to ${first.valueLabel}.` }
        : { kind: "done", text: `Set ${set.length} settings: ${set.map((one) => one.label).join(", ")}.` };
    this.scheduleAutosave();
  }

  /** Answers one of the choices: the value picked becomes a pending edit like any other. */
  chooseLinked(id: string, value: string): void {
    void this.editWith(async () => commands.chooseLinked(id, value));
    this.scheduleAutosave();
  }

  private editOrder(edit: OrderEdit): void {
    void this.editWith(async () => commands.editOrder(edit));
    this.scheduleAutosave();
  }

  /** Turns a mod on or off, which is the line being written or commented out in place. */
  toggleMod(name: string): void {
    this.editOrder({ edit: "toggle", name });
  }

  /** Moves a mod one place, `by` being negative to load it earlier. Refuses to move one off either end. */
  moveMod(name: string, by: number): void {
    this.editOrder({ edit: "shift", name, by });
  }

  /** Puts the mods the recommendation names in its order. Everything else keeps the place the user gave it. */
  sortMods(): void {
    this.editOrder({ edit: "sort" });
  }

  /** Drops an entry naming something no longer in the folder. */
  forgetMod(name: string): void {
    this.editOrder({ edit: "forget", name });
  }

  forgetMissingMods(): void {
    this.editOrder({ edit: "forgetMissing" });
  }

  // ---- Operations that reach the machine ------------------------------------------------------------------

  /**
   * Whether the gate is held, said rather than dropped. These operations can run for minutes on a poor
   * connection, and a click that does nothing at all reads as the button being broken.
   */
  private refusedWhileBusy(): boolean {
    if (this.busy === null) return false;
    this.notice = { kind: "problem", text: `${this.busy} is still running - wait for it to finish.` };
    return true;
  }

  /**
   * Runs one outward-facing operation, reporting whatever it fails with rather than swallowing it. `on` names
   * the mod row it belongs to, when it has one: set here rather than by the caller so a refused click cannot
   * mark a row that never started, and cleared with `busy` so no row can be left claiming to be working.
   */
  private async run(
    what: string,
    work: () => Promise<Notice | null>,
    on?: { id: string; action: ModAction },
  ): Promise<void> {
    if (this.refusedWhileBusy()) return;
    this.busy = what;
    this.modOperation = on ?? null;
    this.notice = null;
    try {
      this.notice = await work();
    } catch (error) {
      // Read from what was asked for rather than from what came back: the rejection crosses a process boundary
      // that keeps the message and drops the type.
      this.notice = this.cancelling
        ? { kind: "note", text: `${what} was stopped. What had been downloaded is kept.` }
        : { kind: "problem", text: `${what} failed: ${reasonOf(error)}` };
    } finally {
      this.busy = null;
      this.modOperation = null;
      this.progress = null;
      this.cancelling = false;
    }
  }

  /**
   * Asks the running operation to stop. It rejects in its own time - a transfer part way through a chunk
   * finishes that chunk first - so this only asks, and `run` reports whatever comes back.
   */
  async cancel(): Promise<void> {
    if (!this.cancellable) return;
    this.cancelling = true;
    await commands.cancel();
  }

  /** Whether the selection is now this install - false where the gate refused it, so a caller can stop. */
  async selectInstall(path: string): Promise<boolean> {
    if (path === this.selectedInstall) return true;
    if (this.refusedWhileBusy()) return false;
    this.clearDialogs();
    try {
      await this.change(async () => commands.selectInstall(path));
    } catch (error) {
      this.notice = { kind: "problem", text: reasonOf(error) };
    }
    return true;
  }

  /** A held plan is dropped whichever install is read next: it belongs to the folder it was planned against. */
  private clearDialogs(): void {
    this.modPlan = null;
    this.modParts = null;
    this.modInputs = null;
  }

  async removeInstall(path: string): Promise<void> {
    // Removing the install an operation is working on would re-read whatever is left, which writes.
    if (this.refusedWhileBusy()) return;
    await this.change(async () => commands.removeInstall(path));
  }

  /** Renames an install, or restores the type's own name when given nothing. */
  async setAlias(path: string, name: string): Promise<void> {
    await this.change(async () => commands.setAlias(path, name));
  }

  async setWine(path: string, wine: WineConfig): Promise<void> {
    await this.change(async () => commands.setWine(path, wine));
  }

  async setTheme(theme: Theme): Promise<void> {
    await this.change(async () => commands.setTheme(theme));
  }

  /** Turning it on writes what is already pending, so the setting and the files agree immediately. */
  async setAutosave(on: boolean): Promise<void> {
    // A write scheduled by the last edit belongs to the setting that was on when it happened: turning autosave
    // off inside that window means the user does not want it written.
    if (!on) this.cancelAutosave();
    await this.change(async () => commands.setAutosave(on));
    if (on && this.modifiedCount > 0) await this.save();
  }

  /*
    Autosave coalesces rather than writing per change: dragging a slider emits a change per pixel, and each
    write rewrites a config file and takes a backup copy. A pending save also has to wait for one already
    running - `run` refuses a second call while busy, which would silently lose the newest edit.
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
    await this.idle();
    if (this.modifiedCount > 0) await this.save();
  }

  /**
   * Opens the shell's picker and adds what comes back. Cancelling adds nothing and says nothing. Aimed at
   * `fallout2.exe`: a folder picker leaves the user guessing which of several similar folders is the game.
   */
  async browseForInstall(): Promise<void> {
    const chosen = await commands.chooseFolder("fallout2.exe");
    if (chosen !== null) await this.addInstall(chosen);
  }

  /** Adds a directory the user pointed at, refusing one that does not hold a game. */
  async addInstall(path: string): Promise<void> {
    if (path.trim() === "") return;
    await this.run("Adding the install", async () => {
      const refusal = await this.changeAnd(async () => commands.addInstall(path));
      return refusal === null ? { kind: "done", text: `Added ${path.trim()}.` } : { kind: "problem", text: refusal };
    });
  }

  async scan(): Promise<void> {
    await this.run("Scanning", async () => {
      const found = await this.changeAnd(commands.scan);
      if (found === 0) return { kind: "done", text: "Nothing found in the usual places." };
      return { kind: "done", text: `Found ${found === 1 ? "one install" : `${found} installs`}.` };
    });
  }

  async save(): Promise<void> {
    if (!this.install) return;
    await this.run("Saving", async () => {
      // After whatever edits are still on their way, so what is written is what the user last did.
      await this.idle();
      const refusal = await this.changeAnd(commands.save);
      // A save that worked says so by clearing the unsaved chip; only a refusal is worth a banner.
      return refusal === null ? null : { kind: "problem", text: refusal.text };
    });
  }

  // ---- Mods -----------------------------------------------------------------------------------------------

  /**
   * Both halves of the listing, from one reading of the feeds. Apart from `run` for the startup read, which
   * nobody asked for and so holds no gate.
   */
  private async readModListing(refresh: boolean): Promise<void> {
    this.modReads += 1;
    try {
      await this.change(async () => commands.readModListing(refresh));
    } finally {
      this.modReads -= 1;
    }
  }

  /** Both halves, for the Mods tab's Refresh button - the one control that asks the feeds again. */
  async loadModOffers(refresh = false): Promise<void> {
    if (!this.install) return;
    await this.run("Reading the mod feeds", async () => {
      await this.readModListing(refresh);
      return null;
    });
  }

  /**
   * Downloads and verifies a release, then holds its resolved plan up for the user's word. A release that
   * offers parts is asked about first, unless the record's choice carried over.
   */
  async prepareMod(
    offer: ModOffer,
    chosen?: readonly string[],
    answers?: Readonly<Record<string, string>>,
    version?: string,
  ): Promise<void> {
    if (!this.install) return;
    const carried = offer.choices?.carried;
    if (chosen === undefined && carried?.ask) {
      this.modParts = { offer, chosen: carried.selection, ...(version !== undefined ? { version } : {}) };
      return;
    }
    const parts = chosen ?? carried?.selection;
    // After the choice rather than before it: what a release publishes is its own question, and the folders on
    // this machine are asked for once that is settled.
    if (answers === undefined && offer.asks.length > 0) {
      this.modInputs = { offer, chosen: parts ?? [], answers: {}, ...(version !== undefined ? { version } : {}) };
      return;
    }
    const wanted = version ?? offer.version;
    await this.run(
      `Preparing ${offer.name} ${wanted}`,
      async () => {
        const plan = await commands.planMod(offer.id, parts, answers, version);
        this.modPlan = { offer, plan, version: wanted };
        return null;
      },
      { id: offer.id, action: "prepare" },
    );
  }

  /**
   * Opens the choice of version. What the install already carries goes with the request where it is a floor:
   * only a base mod has one, its installer having no way back down, and the type that decides is the one on
   * disk, which a conversion states separately.
   */
  async chooseModVersion(offer: ModOffer): Promise<void> {
    const state = offer.availability;
    const onDisk = state.kind === "convert" ? state.was : offer.modType;
    const held =
      onDisk === "base" && (state.kind === "upgrade" || state.kind === "downgrade" || state.kind === "convert")
        ? state.from
        : undefined;
    this.modVersionPick = { offer, versions: [], read: false };
    await this.run(`Reading the ${offer.name} versions`, async () => {
      try {
        const versions = await commands.modVersions(offer.id, held);
        // The dialog may have been dismissed, or another row's opened, while the list was on its way.
        if (this.modVersionPick?.offer.id === offer.id) this.modVersionPick = { offer, versions, read: true };
      } catch (error) {
        // Closed rather than left saying "reading": a dialog still claiming to load a list that will never arrive
        // is the one state worse than no dialog.
        if (this.modVersionPick?.offer.id === offer.id) this.modVersionPick = null;
        throw error;
      }
      return null;
    });
  }

  dismissModVersion(): void {
    this.modVersionPick = null;
  }

  /** Opens the shell's picker for one of a mod's questions, aimed at the file the answer has to hold. */
  async browseForModInput(id: string): Promise<void> {
    const held = this.modInputs;
    if (!held) return;
    const asked = held.offer.asks.find((one) => one.id === id);
    const chosen = await commands.chooseFolder(asked?.holds);
    if (chosen === null) return;
    // Re-read rather than closed over: the picker is a round trip, and the dialog may have moved on.
    const open = this.modInputs;
    if (open?.offer.id !== held.offer.id) return;
    this.modInputs = { ...open, answers: { ...open.answers, [id]: chosen } };
  }

  /** The folders go on to the plan, which resolves them against the release and is the confirmation proper. */
  async confirmModInputs(): Promise<void> {
    const held = this.modInputs;
    this.modInputs = null;
    if (held) await this.prepareMod(held.offer, held.chosen, held.answers, held.version);
  }

  dismissModInputs(): void {
    this.modInputs = null;
  }

  /** Ticks or unticks one part, by the rule that keeps a selection one the install would accept. */
  async setModPart(id: string, on: boolean): Promise<void> {
    const held = this.modParts;
    const groups = held?.offer.choices?.groups;
    if (!held || !groups) return;
    const chosen = await commands.toggleModPart(groups, held.chosen, id, on);
    // The dialog may have closed while the answer was on its way.
    if (this.modParts?.offer.id !== held.offer.id) return;
    this.modParts = { ...this.modParts, chosen };
  }

  /** The chosen parts go on to the plan, which is the confirmation proper. */
  async confirmModParts(): Promise<void> {
    const held = this.modParts;
    this.modParts = null;
    if (held) await this.prepareMod(held.offer, held.chosen, undefined, held.version);
  }

  dismissModParts(): void {
    this.modParts = null;
  }

  /** The confirmed plan is executed; the plan dialog closes either way, the working directory persists. */
  async confirmModInstall(): Promise<void> {
    const held = this.modPlan;
    this.modPlan = null;
    if (!held || !this.install) return;
    await this.run(
      `Installing ${held.offer.name} ${held.version}`,
      async () => {
        // The plan's own choices and folders, not the dialogs': what runs is what the resolved plan said it would.
        const plan = held.plan;
        const report = await this.changeAnd(async () =>
          commands.installMod({
            modId: held.offer.id,
            fingerprint: plan.fingerprint,
            choices: plan.kind === "stacking" ? (plan.parts ?? []) : [],
            answers: plan.kind === "creates" ? plan.inputs : {},
            version: held.version === held.offer.version ? null : held.version,
          }),
        );
        if (report.refusedRegistration !== null) return { kind: "problem", text: report.refusedRegistration };
        const outcome = report.outcome;
        const conflicts =
          outcome.conflicts.length > 0
            ? ` ${outcome.conflicts.length} setting(s) you had changed were kept over the release's new defaults.`
            : "";
        const beside = outcome.kind === "creates" ? ` ${outcome.created} is now on the list of installations.` : "";
        const skipped =
          outcome.kind === "creates" && outcome.skipped.length > 0 ? ` ${skippedText(outcome.skipped)}` : "";
        return {
          kind: "done",
          text: `${held.offer.name} ${outcome.version} installed.${conflicts}${beside}${skipped}`,
        };
      },
      { id: held.offer.id, action: "install" },
    );
  }

  /** Cancelling the plan keeps the working directory, so a later attempt resumes rather than re-downloads. */
  dismissModPlan(): void {
    this.modPlan = null;
  }

  async removeMod(offer: ModOffer): Promise<void> {
    if (!this.install) return;
    await this.run(
      `Removing ${offer.name}`,
      async () => {
        await this.change(async () => commands.removeMod(offer.id));
        return { kind: "done", text: `${offer.name} removed. Copies are in the backup folder.` };
      },
      { id: offer.id, action: "remove" },
    );
  }

  /** Opens one of an installed mod's own inis - the route to the sections its schema does not cover. */
  async openModIni(modId: string, file: string): Promise<void> {
    if (!this.install) return;
    await this.run("Opening the file", async () => {
      await commands.openModFile(modId, file);
      return null;
    });
  }

  /** Unwinds an install that never finished, from the working directory's copies. */
  async restoreMod(offer: ModOffer): Promise<void> {
    if (!this.install) return;
    await this.run(
      `Restoring before ${offer.name}`,
      async () => {
        await this.change(async () => commands.restoreMod(offer.id));
        return { kind: "done", text: `The install is back to what it was before ${offer.name}.` };
      },
      { id: offer.id, action: "restore" },
    );
  }

  // ---- Running the game -----------------------------------------------------------------------------------

  /**
   * Starts the game, through an engine when one is named and the original executable otherwise.
   *
   * An engine that declares a caution stops here rather than starting, and so does a launch that would swap
   * the mod order into another engine's format: a caution is said until dismissed, a swap every time, since it
   * rewrites a file the user owns.
   */
  async play(engineId: string | null = null, pick: BuildPick | null = null): Promise<void> {
    if (!this.install) return;
    const engine = engineId === null ? null : (this.engines.find((one) => one.id === engineId) ?? null);
    let swap: OrderSwap | null;
    try {
      swap = await commands.orderSwap(engineId);
    } catch (error) {
      this.notice = { kind: "problem", text: reasonOf(error) };
      return;
    }
    const cautioned = engine?.caution != null && !this.acceptedCautions.includes(engine.id);
    if (cautioned || swap !== null) {
      this.pendingLaunch = {
        engine,
        caution: cautioned ? (engine?.caution ?? null) : null,
        pick,
        // The one engine whose mount rule ZAX models.
        missed: engine?.id === "fission" ? this.fissionMissed : [],
        swap,
      };
      this.pendingLaunchId = engineId;
      return;
    }
    await this.startGame(engineId, pick);
  }

  /**
   * Goes ahead with the launch the dialog held. `accepted` is its box, recorded before the launch rather than
   * after it, so a game that does not come back still leaves the answer written.
   */
  async confirmLaunch(accepted: boolean): Promise<void> {
    const pending = this.pendingLaunch;
    if (!pending) return;
    const engineId = this.pendingLaunchId;
    this.pendingLaunch = null;
    if (accepted && pending.caution !== null && pending.engine) {
      const id = pending.engine.id;
      await this.change(async () => commands.acceptCaution(id));
    }
    await this.startGame(engineId, pending.pick);
  }

  dismissLaunch(): void {
    this.pendingLaunch = null;
  }

  private async startGame(engineId: string | null, pick: BuildPick | null): Promise<void> {
    const engine = engineId === null ? null : this.engines.find((one) => one.id === engineId);
    await this.run(engine ? `Starting the game in ${engine.short}` : "Starting the game", async () => {
      await this.change(async () => commands.launch(engineId, pick));
      return null;
    });
  }

  // ---- Versions ------------------------------------------------------------------------------------------

  async checkZaxVersion(): Promise<void> {
    await this.run("Checking for a newer ZAX", async () => {
      await this.change(commands.checkZax);
      return null;
    });
  }

  async checkSfallVersion(): Promise<void> {
    await this.run("Checking for a newer sfall", async () => {
      await this.change(commands.checkSfall);
      return null;
    });
  }

  async loadSfallVersions(): Promise<void> {
    if (this.sfallVersions.length > 0) return;
    await this.run("Reading the sfall versions", async () => {
      this.sfallVersions = await commands.listSfallVersions();
      this.sfallVersionsRead = true;
      if (this.sfallVersions.length === 0) {
        return { kind: "problem", text: "The release listing named no versions. It may be worth trying again." };
      }
      return null;
    });
  }

  /**
   * Puts a given version of sfall into the install, whichever direction that is. Installing, updating and going
   * back are one operation; the labels differ, so the caller says what it was doing.
   */
  async changeSfall(version: string, doing = "Updating sfall"): Promise<void> {
    if (!this.install) return;
    await this.run(doing, async () => {
      const result = await this.changeAnd(async () => commands.changeSfall(version));
      const kept = result.backup === null ? "" : ` Replaced files are in ${result.backup}.`;
      // Both sides changed these, and the user's won. Named rather than counted: it is the part worth a look.
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
    if (!this.install) return;
    await this.run("Installing sfall", async () => {
      const result = await this.changeAnd(async () => commands.changeSfall(null));
      return { kind: "done", text: `sfall ${result.version} is installed.` };
    });
  }

  // ---- Engines --------------------------------------------------------------------------------------------

  /** What one engine has published, for the button that asks again after the startup check. */
  async checkEngine(engineId: string): Promise<void> {
    const engine = this.engines.find((one) => one.id === engineId);
    await this.run(`Checking for a newer ${engine?.short ?? "engine"}`, async () => {
      await this.change(async () => commands.checkEngine(engineId));
      return null;
    });
  }

  /**
   * Downloads a build into the machine's cache. An engine that declares a caution says it once here, before
   * its first build is on the machine at all; holding a build is what makes it not the first.
   */
  async fetchEngine(engineId: string, published: string | null = null): Promise<void> {
    const engine = this.engines.find((one) => one.id === engineId);
    if (engine?.caution != null && engine.versions.length === 0) {
      this.pendingFetch = { engine, published };
      return;
    }
    await this.startFetch(engineId, published);
  }

  /** Goes ahead with the fetch the caution stopped. */
  async confirmFetch(): Promise<void> {
    const pending = this.pendingFetch;
    if (!pending) return;
    this.pendingFetch = null;
    await this.startFetch(pending.engine.id, pending.published);
  }

  dismissFetch(): void {
    this.pendingFetch = null;
  }

  private async startFetch(engineId: string, published: string | null): Promise<void> {
    const engine = this.engines.find((one) => one.id === engineId);
    await this.run(`Fetching ${engine?.name ?? "the engine"}`, async () => {
      const release = await this.changeAnd(async () => commands.fetchEngine(engineId, published));
      return { kind: "done", text: `${engine?.name ?? engineId} ${release.release} is ready to run.` };
    });
  }

  /** Drops one build from the cache. A folder already running it keeps the copy it holds. */
  async forgetEngine(engineId: string, published: string): Promise<void> {
    const engine = this.engines.find((one) => one.id === engineId);
    await this.run(`Removing ${engine?.name ?? "the engine"}`, async () => {
      await this.change(async () => commands.forgetEngine(engineId, published));
      return null;
    });
  }

  /**
   * Puts a build in the selected folder without starting the game, and records the pick. Nothing to report -
   * the folder's line on the Engines tab changes, which is the answer.
   */
  async useEngineBuild(engineId: string, pick: BuildPick): Promise<void> {
    if (!this.install) return;
    const engine = this.engines.find((one) => one.id === engineId);
    await this.run(`Putting ${engine?.name ?? "the engine"} in this game`, async () => {
      await this.change(async () => commands.useEngineBuild(engineId, pick));
      return null;
    });
  }

  // ---- The rest -------------------------------------------------------------------------------------------

  async saveSlots(): Promise<readonly string[]> {
    return this.install ? commands.listSaves() : [];
  }

  async createDebugPackage(saves: readonly string[]): Promise<void> {
    if (!this.install) return;
    await this.run("Creating the debug package", async () => {
      const result = await commands.createDebugPackage(saves);
      // Opened where it was written: the next step is attaching the file to a report. A machine that cannot
      // open a directory reports the path rather than a failure, since the archive is what was asked for.
      try {
        await commands.open({ what: "own", directory: "debug" });
      } catch {
        // Nothing to add: the notice below already says where the file is.
      }
      return { kind: "done", text: `Wrote ${result.path} - ${result.contents.length} files.` };
    });
  }

  async open(target: OwnPlace | "download" | OpenTarget): Promise<void> {
    const named: OpenTarget =
      typeof target !== "string"
        ? target
        : target === "log"
          ? { what: "log" }
          : target === "download"
            ? { what: "download" }
            : { what: "own", directory: target };
    await this.run("Opening", async () => {
      await commands.open(named);
      return null;
    });
  }

  async wipe(which: OwnPlace): Promise<void> {
    await this.run(which === "log" ? "Clearing the log" : "Emptying the directory", async () => {
      await commands.wipe(which === "log" ? { what: "log" } : { what: "own", directory: which });
      return { kind: "done", text: which === "log" ? "Cleared the log." : `Emptied the ${which} directory.` };
    });
  }
}

export const store = new Store();
