import {
  INSTALL_MARKER,
  IniDocument,
  addInstall,
  compareVersions,
  describeValueTest,
  isApplied,
  matchesValueTest,
  newInstall,
  ownTarget,
  removeInstall,
  searchText,
  setAlias,
  valueLabel,
  valueSatisfying,
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
  type SettingTarget,
  type WineConfig,
} from "@zax/core";
import {
  ACTIONS,
  CONFIG_FILES,
  ENGINES,
  LAYOUT,
  MODS_ORDER_PATH,
  SETTINGS,
  againstRecommendation,
  describePlace,
  engineById,
  engineOutdated,
  hasMintedSettings,
  hiddenIds,
  listMods,
  listingFrom,
  liveTargets,
  reconcileSettings,
  placesById,
  recommendationFor,
  recommendedOrder,
  wrapMethods,
  type Backend,
  type Divergence,
  type CachedBuild,
  type EngineListing,
  type EngineRelease,
  type InstalledEngine,
  type HeldTarget,
  type LayoutFile,
  type MachineDescription,
  type Mod,
  type BaseInstallPlan,
  type CreateInstallPlan,
  type ModInstallPlan,
  type ModFeedListing,
  type ModInstallState,
  type ModListing,
  type ModOffer,
  type ModSetting,
  type ModSettingsGroup,
  type ModsSnapshot,
  type OpenTarget,
  type OperationProgress,
  type WipeTarget,
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

// Built once: the layout does not change at runtime, and every search result needs a lookup in it.
const PLACES = placesById();
const HIDDEN = hiddenIds();

// Keyed by every target, not just each setting's own address: a key a linked setting also writes is that
// setting seen from another file, and indexing only the first address would make `discover` invent a second
// raw row for it.
const CURATED = new Map(
  SETTINGS.flatMap((s) => s.targets.map((t) => [`${t.file}|${t.section}|${t.key}`.toLowerCase(), s] as const)),
);

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
 * Every key the config files actually contain. The catalog curates 227 of them; sfall's ddraw.ini alone holds
 * 115 keys, most undocumented by the catalog but documented by its own inline comments, which become the help
 * text for free.
 */
function discover(documents: Record<string, IniDocument>): SettingDef[] {
  const out: SettingDef[] = [];
  for (const file of CONFIG_FILES) {
    for (const entry of documents[file]?.entries() ?? []) {
      const curated = CURATED.get(`${file}|${entry.section}|${entry.key}`.toLowerCase());
      if (curated) {
        // Once per setting, not once per key it was found under: a linked setting is reached from an engine's
        // own keys as well as from its own, and a second entry would be the same id listed twice. A scan of
        // what is already there rather than a set beside it - the list runs to a few hundred, once per load.
        if (!out.some((seen) => seen.id === curated.id)) out.push(curated);
        continue;
      }
      out.push({
        id: `raw.${file}.${entry.section}.${entry.key}`.toLowerCase(),
        targets: [{ file, section: entry.section, key: entry.key }],
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

/** Which sub-tab of Settings: a group of the layout's, or one of the tabs that belongs to no config file. */
export type SettingsTab = string;

/** The tabs the layout does not supply, which stay whatever the install holds. */
const FIXED_SETTINGS_TABS = new Set(["all", "install", "trouble"]);

/** A group of settings tabs to offer, and the reason its rows will not take input, where there is one. */
export interface SettingsGroup {
  group: LayoutFile;
  refusal: string | null;
}

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
export type View = "settings" | "mods" | "engines";

/** The Mods view's own tabs: getting mods, ordering them, and configuring them are three different jobs. */
export type ModsTab = "installation" | "order" | "settings";

/** Which of a mod row's controls started what is running - one label each, and the button says it. */
export type ModAction = "prepare" | "install" | "remove" | "restore";

/**
 * Something that happened and the user needs told: a save, a refusal, a failure. `note` is the third case -
 * ZAX did something the user did not ask for and would want to know about, which is neither a completed
 * action nor a fault, and reads as neither.
 */
export interface Notice {
  kind: "done" | "problem" | "note";
  text: string;
}

/** A disagreement this load put in front of the user, and everything undoing the answer needs to know. */
export interface Reconciled {
  /**
   * The file the value was carried from - what the row says, so a change ZAX made unasked names its source.
   * Absent where the user picked between two that had both moved: they know where their own answer came
   * from, and a row is not told what it already did.
   */
  from?: string;
  /** Every address the setting was weighed at, as it then read. The base a revert of the answer accepts. */
  at: readonly HeldTarget[];
}

/**
 * Edits are held as a sparse override map rather than applied to the parsed documents. That keeps
 * "what did I change" and revert trivial, and it is the shape a saved profile will store.
 */
/*
  One object rather than one per view, and long because of it. The split that suggests itself - settings,
  mods, installs, updates - does not hold: almost every method reads `selectedInstall`, `busy`, `progress` and
  `notice`, and the pieces would go on sharing them through something passed between them. That trades a long
  file for the same coupling plus the indirection, and reintroduces the question of who owns a field. The
  reason to revisit it is a piece that stops touching the shared four, not the line count.
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
  /** Whether an edit is written as it is made. On by default: a save rewrites only the keys that changed, and
   * an edit left waiting on a second click is one the user can walk away from. */
  autosave = $state(true);
  overrides = $state<Record<string, string>>({});

  /** Contents of the selected install's config files, exactly as they were read. */
  contents = $state<ConfigFileContents>({});

  /**
   * What the feeds have published, or null before the first read. A repository publishes one release
   * whichever game is selected, so this outlives a switch the way `sfallLatest` does.
   */
  modFeeds = $state<ModFeedListing | null>(null);
  /** Where the selected install stands against them, which is the half a change of game invalidates. */
  modStanding = $state<ModInstallState | null>(null);
  /**
   * The two as the Mods tab reads them, or null until both halves are in. Derived rather than stored: the
   * halves arrive from different reads, and a listing kept beside them is a third copy to keep in step. A
   * rune rather than the cached getter `results` uses - that one caches against a value it also reads, which
   * as a rune would loop; this is a function of two fields and nothing else.
   */
  modListing = $derived<ModListing | null>(
    this.modFeeds && this.modStanding ? listingFrom(this.modFeeds, this.modStanding) : null,
  );
  /** How many reads of either half are out. Counted rather than flagged, since the two overlap. */
  private modReads = $state(0);
  /**
   * Whether the Mods tab is waiting on one. Not `busy`: the read a change of game starts is not an operation
   * the user asked for, so it holds no gate - and without this the tab spent that read saying the feeds had
   * never been asked.
   */
  readingOffers = $derived(this.modReads > 0);
  /**
   * Which install the per-install state was last read for, so a reread can tell a change of game from a
   * reread of the same one, and how many reads of it have been started. Plain, not `$state`: nothing renders
   * either, and a reactive read here would tie every view that touches the install to them.
   */
  private readFor = "";
  private standingRequest = 0;
  /**
   * A resolved install plan awaiting the user's word, with the offer it belongs to. Two shapes: a stacking
   * mod's names every file, and a base mod's names the release and the space, the installer owning the rest.
   */
  modPlan = $state<{
    offer: ModOffer;
    plan: ModInstallPlan | BaseInstallPlan | CreateInstallPlan;
    /** The version this plan is for, which is the offer's unless the user picked another. */
    version: string;
  } | null>(null);
  /** The chooser while it is open: the offer whose choice is being made, and what is ticked in it. */
  modParts = $state<{ offer: ModOffer; chosen: readonly string[]; version?: string } | null>(null);
  /**
   * The folders a mod has to be pointed at before it can be planned, while that question is open. Its own
   * dialog rather than the chooser's: what is being asked for is a path on this machine, not a choice
   * between things the release publishes.
   */
  modInputs = $state<{
    offer: ModOffer;
    chosen: readonly string[];
    answers: Record<string, string>;
    version?: string;
  } | null>(null);
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
  /**
   * Which mod row the running operation belongs to, when it belongs to one. The top bar says what is
   * happening; this is what lets the button that started it say so rather than only greying out.
   */
  private modOperation = $state<{ id: string; action: ModAction } | null>(null);
  notice = $state<Notice | null>(null);
  /**
   * Settings whose engines this load found disagreeing and which now have an answer - one ZAX carried across
   * from an engine's own file, or one the user picked. A carry names the file it came from and the row says
   * so: a link cannot be broken, so a difference someone meant to keep is lost by being reconciled, and the
   * only defence is that it is never lost quietly.
   *
   * Both kinds sit here because both are answers a revert has to accept rather than merely undo. Rebuilt by
   * every read, so an entry only ever describes the install now selected.
   */
  reconciled = $state<Record<string, Reconciled>>({});
  /**
   * The banner the carry raised, while it is still the one showing. Held by identity rather than by a flag:
   * reverting the carry has to take its banner down with it, and must not take down a save's report that
   * landed on top of it in the meantime.
   */
  private carryNotice: Notice | null = null;
  /** Linked settings whose engines have each moved since ZAX wrote, so which value survives is the user's. */
  settingsChoices = $state<Divergence[]>([]);

  /**
   * Answers one of those choices: the value picked becomes a pending edit like any other, so it reaches every
   * address of the setting on the next save and can be reverted before it does. The choice leaves the list
   * once answered, which is what closes the prompt - there is nothing further to decide about that setting.
   *
   * The answer joins the carries as something a revert accepts, and by the same reasoning: reverting it says
   * the engines may differ after all, and without recording that the question is asked again on the next
   * read. Only once answered - an untouched choice is nothing the user has decided, so a revert leaves it
   * standing rather than dismissing a question on their behalf.
   */
  chooseLinked(id: string, value: string): void {
    const answered = this.settingsChoices.find((one) => one.id === id);
    this.set(id, value);
    this.settingsChoices = this.settingsChoices.filter((one) => one.id !== id);
    if (answered) this.reconciled = { ...this.reconciled, [id]: { at: answered.at } };
  }

  /** Whether this row's own control is the one running - a button's cue to change its label. */
  modWorking(id: string, action: ModAction): boolean {
    return this.modOperation?.id === id && this.modOperation.action === action;
  }

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
  /**
   * Every engine ZAX knows, against this machine: which builds the cache holds. Read at startup and after a
   * fetch or a drop, never on an install switch - none of it is the selected folder's business, and rereading
   * it there is what used to take a Run in X button off the bar for the length of the reads.
   */
  engines = $state<readonly EngineListing[]>([]);
  /** What is deployed in the selected folder, by engine id. Read with the install. */
  engineDeployed = $state<Record<string, InstalledEngine>>({});
  /**
   * What each engine has published, by id: asked for at startup, and by the Check button after that. One
   * release is published whichever folder is selected, so switching install leaves it alone.
   */
  engineLatest = $state<Record<string, EngineRelease>>({});
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
   * derived from `contents`: this is three file parses and a pass over 227 settings, and a derivation would
   * repeat it on every access from a plain function call.
   */
  private baseline: Record<string, string | undefined> = $state({});
  private rawBaseline: Record<string, string | undefined> = $state({});
  /**
   * Linked settings whose addresses do not all hold the same value, as of the last read.
   *
   * `baseline` holds the setting's own address alone, which is the value every control shows - and while the
   * addresses agree that is a sound stand-in for all of them. While they do not, it is not: an edit matching
   * the own address still changes the ones that hold something else, so an edit here is a real edit however
   * it compares to what is on screen. Read off the reconciliation that already worked it out, rather than
   * asked of the files a second time.
   */
  private split: Record<string, true> = $state({});
  discovered = $state<SettingDef[]>([]);

  private index(): void {
    const modDefs = [...this.modById.values()];
    // The mods' ini files parse alongside the engine's; `discover` still walks CONFIG_FILES alone, so the
    // raw every-key view never extends to mod inis - the schema is their whole surface, by design.
    const files = [...new Set<string>([...CONFIG_FILES, ...modDefs.map((s) => ownTarget(s).file)])];
    const documents = Object.fromEntries(files.map((f) => [f, IniDocument.parse(this.contents[f] ?? "")]));
    // Read at the setting's own address. Reconciling a linked setting's targets against each other needs the
    // engine's own record of what ZAX last wrote, which no file here carries.
    const valueOf = (s: SettingDef) => {
      const at = ownTarget(s);
      return documents[at.file]?.get(at.section, at.key);
    };
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
      if (!this.hasFile(ownTarget(s).file)) continue;
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
    // Before the install read, so the Run bar draws with its buttons rather than gaining them a moment later.
    await this.readMachineEngines();
    await this.readInstall();
    this.loaded = true;
    // Not awaited: the interface is usable without any of it, and each answer lands in its own field when it
    // arrives. Awaiting here would hold the whole window open on the slowest of them.
    void this.checkForUpdates();
  }

  /**
   * Every check the views otherwise wait for a click to make: what ZAX, sfall, the engines and the mod feeds
   * have published. Off the `busy` gate on purpose - nobody asked for these, so holding the gate would grey
   * out the controls and refuse the user's first click over a request of ZAX's own making. All four are the
   * same answer for every install, which is why they are asked here once and not per game.
   *
   * A failure leaves its field alone rather than reporting: the views already have a state for an answer that
   * has not arrived, and several notices about an offline machine would bury the state file's own problems.
   * Each of these still has a button behind it that reports properly when it is pressed.
   */
  async checkForUpdates(): Promise<void> {
    await Promise.all([
      quietly(async () => {
        this.zaxLatest = (await backend.latestZax()).version;
      }),
      quietly(async () => {
        this.sfallLatest = await backend.latestSfall();
      }),
      quietly(() => this.refreshModFeeds()),
      // Only the ones this machine could actually install, which is the condition the Check button carries.
      ...this.engines
        .filter((engine) => engine.build !== null)
        .map((engine) =>
          quietly(async () => {
            const [newest] = await backend.engineReleases(engine.id);
            if (newest) this.engineLatest = { ...this.engineLatest, [engine.id]: newest };
          }),
        ),
    ]);
  }

  /** Rereads the selected install: its config files, which sfall and hi-res patch it has, and its engines. */
  private async readInstall(): Promise<void> {
    const install = this.install;
    // Every caller rereads the install, but only a few change which one it is - and where the mods stand is
    // the one thing here that no other caller can have changed, since it is read from the folder this names.
    // Saving a setting or installing an engine used to blank the Mods tab back to unread over it.
    const switched = (install?.path ?? "") !== this.readFor;
    this.readFor = install?.path ?? "";
    this.sfallInstalled = null;
    this.hiresInstalled = null;
    // Before the reads below, which are awaited and so can render between them: another game's disagreements
    // would mark rows of this one, and "nothing is split" is the reading that mismarks nothing.
    this.split = {};
    // `engines` is the machine's and is left alone here: a folder switch moves what is deployed, not what the
    // cache holds, and rereading the listing took every Run in X button off the bar for the length of the reads.
    this.engineDeployed = {};
    // Another install's standing would be wrong here. What the feeds published is left alone: one release is
    // published for every game, which is why the two are read apart in the first place.
    if (switched) {
      this.modStanding = null;
      // Started on the line that empties the tab rather than after the rest of the install has been reread:
      // nothing below feeds it, and the gap between the two is time spent saying the feeds were never asked.
      if (install) void quietly(() => this.refreshModOffers(install));
    }
    // A held plan is dropped whichever install this is: it is how the flow that just ran closes its dialog.
    this.modPlan = null;
    this.modParts = null;
    this.modInputs = null;
    if (!install) {
      this.contents = {};
      this.modSettings = [];
      this.modById = new Map();
      this.index();
      this.overrides = {};
      // With nothing selected there is nothing to reconcile, and a question left standing would be asked
      // about a game no longer on screen.
      this.reconciled = {};
      this.settingsChoices = [];
      this.split = {};
      this.setMods({ text: undefined, present: [], owners: [] });
      return;
    }
    this.contents = await backend.loadConfigFiles(install.path);
    // Before the index, which folds the schemas' values into the baseline the controls read.
    this.modSettings = await backend.modSettings(install);
    this.modById = new Map(this.modSettings.flatMap((group) => group.settings.map((s) => [s.id, s])));
    this.index();
    this.overrides = await this.applyPins(install.path);
    await this.settleLinked(install.path);
    await this.readMods(install);
    this.sfallInstalled = await backend.installedSfallVersion(install);
    this.hiresInstalled = await backend.installedHiresVersion(install);
    this.engineDeployed = Object.fromEntries((await backend.deployedEngines(install)).map((one) => [one.id, one]));
    // Last, because it reads what is deployed above: an engine's tab goes when the engine does, and a
    // selection left pointing at it would show neither that tab nor any other.
    this.settleSettingsTab();
  }

  /** Falls back to the game's own first tab when the selected one is no longer offered. */
  private settleSettingsTab(): void {
    if (FIXED_SETTINGS_TABS.has(this.settingsTab)) return;
    if (this.settingsGroups.some((one) => one.group.id === this.settingsTab)) return;
    this.settingsTab = LAYOUT[0]!.id;
  }

  /**
   * Carries a linked setting's newer value across to the engines that have not got it yet.
   *
   * Left pending rather than written where the user saves for themselves: this is a value they set somewhere
   * else - inside an engine's own preferences screen, or by hand - so it is put in front of them as an edit
   * they can undo, not applied to three files during a load they only meant as a load. A setting whose
   * engines have both moved is not settled at all; which value survives is theirs to pick.
   *
   * Under autosave it is written here instead, for the same reason the pending form exists: the user has to
   * be able to act on it. Autosave disables Save and draws no revert control, so a carry queued there is an
   * edit nobody can save or undo, under a banner asking for both - and it blocks every mod flow, which
   * refuses to run over unsaved edits. Written, the banner reports what happened rather than asking.
   */
  private async settleLinked(installPath: string): Promise<void> {
    const carried = await this.reconcileLinked(installPath);
    const count = Object.keys(carried).length;
    this.carryNotice = null;
    if (count === 0) return;
    const what = count === 1 ? "One setting was" : `${count} settings were`;
    const carry = `${what} changed outside ZAX and carried across to the other engines.`;
    if (this.autosave && (await this.writeCarried(installPath, carried))) {
      // Read back rather than assumed: the write moved each address's base with it, so this settles nothing
      // further and leaves the rows describing the install as it now stands.
      await this.reconcileLinked(installPath);
      this.carryNotice = this.notice = { kind: "note", text: carry };
      return;
    }
    this.carryNotice = this.notice = { kind: "note", text: `${carry} Save to keep them, or revert.` };
  }

  /** Weighs each engine's copy against its base, queues what ZAX can settle, and answers what it carried. */
  private async reconcileLinked(installPath: string): Promise<Record<string, Reconciled>> {
    const found = reconcileSettings(SETTINGS, this.contents, await backend.settingsBase(installPath));
    const carried: Record<string, Reconciled> = {};
    const next = { ...this.overrides };
    for (const one of found) {
      if (!one.settle) continue;
      next[one.id] = one.settle.value;
      carried[one.id] = { from: one.settle.target.file, at: one.at };
    }
    this.overrides = next;
    this.reconciled = carried;
    this.settingsChoices = found.filter((one) => one.choose !== undefined);
    // Every disagreement, including the ones already accepted - what makes an edit to them count as one.
    this.split = Object.fromEntries(found.map((one) => [one.id, true as const]));
    return carried;
  }

  /**
   * Writes the values just carried across, answering whether they took. A refusal leaves them queued, which
   * is the state the banner then describes - the alternative is a load that quietly loses them.
   */
  private async writeCarried(installPath: string, carried: Record<string, Reconciled>): Promise<boolean> {
    const values = Object.fromEntries(Object.entries(this.overrides).filter(([id]) => id in carried));
    const outcome = await backend.saveConfigFiles({
      installPath,
      original: this.contents,
      changes: this.pendingChanges(values),
    });
    if (!outcome.ok) return false;
    this.contents = await backend.loadConfigFiles(installPath);
    this.index();
    // Dropped before the read back, which would otherwise carry them forward as edits of the user's own.
    this.overrides = Object.fromEntries(Object.entries(this.overrides).filter(([id]) => !(id in carried)));
    return true;
  }

  /**
   * Accepts the files as they stand for answers that have just been reverted - a carry ZAX made, or a choice
   * the user answered. One gate for both: what a revert undoes differs, what it means does not.
   *
   * Reverting is the user saying these engines may disagree. Dropping the pending edit is only half of that:
   * nothing on disk changes, so the next read of this install weighs the same files against the same bases
   * and reaches the same answer again - which it did on every switch between games. Moving each address's
   * base to what it now holds is what makes the answer stick, and a later change inside an engine still
   * reads as a move against it.
   */
  private async acceptReconciled(ids: readonly string[]): Promise<void> {
    const install = this.install;
    const dropped = ids.filter((id) => this.reconciled[id] !== undefined);
    if (!install || dropped.length === 0) return;
    const at = dropped.flatMap((id) => this.reconciled[id]!.at);
    try {
      await backend.acceptSettingsBase(install.path, at);
    } catch (error) {
      // The edit is dropped either way, but a base that did not move means the next read of this install
      // reaches the same answer again - which reads as the revert never having worked. The rows keep saying
      // where their value came from, since that is still true.
      const reason = error instanceof Error ? error.message : String(error);
      this.notice = { kind: "problem", text: `The revert could not be recorded: ${reason}` };
      return;
    }
    this.reconciled = Object.fromEntries(Object.entries(this.reconciled).filter(([id]) => !dropped.includes(id)));
    // Only while it is still the banner the carry raised, and only once no carry is left for it to describe -
    // an answered choice sits in the same map but was never one of the settings that banner counted.
    const carries = Object.values(this.reconciled).some((one) => one.from !== undefined);
    if (!carries && this.notice === this.carryNotice) {
      this.notice = null;
      this.carryNotice = null;
    }
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
    if (this.busy !== null) {
      // Said rather than dropped. These operations can run for minutes on a poor connection, and a click that
      // does nothing at all reads as the button being broken rather than as the application being busy.
      this.notice = { kind: "problem", text: `${this.busy} is still running - wait for it to finish.` };
      return;
    }
    this.busy = what;
    this.modOperation = on ?? null;
    this.notice = null;
    try {
      this.notice = await work();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.notice = { kind: "problem", text: `${what} failed: ${reason}` };
    } finally {
      this.busy = null;
      this.modOperation = null;
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
    // The install's record is written straight away where the config targets wait for a save: it lives in ZAX's
    // own state file, which has no pending layer for an edit to sit in.
    const install = this.install;
    if (action.wine && install && this.wineAvailable) {
      void this.setWine(install.path, { ...install.wine, debug: action.wine.debug });
    }
  }

  actionApplied(action: Action): boolean {
    return isApplied(action, (id) => this.valueOf(id), this.actionWineDebug);
  }

  /**
   * What an action's Wine half is compared against: the selected install's value, or null on Windows, where the
   * field is hidden and an action must not sit unapplied over something the user cannot reach.
   */
  get actionWineDebug(): string | null {
    if (!this.wineAvailable) return null;
    return this.install?.wine?.debug ?? "";
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
  /**
   * The address a row shows, which follows the group of tabs it sits on: a linked setting has one per
   * component, and only the one the tab belongs to is the address that tab is about. Falls back to the
   * setting's own where the group holds no target for it, which is what a search result gets.
   */
  /**
   * What else a row's value is written to: every address of the setting but the one this row shows, each
   * with whether an edit reaches it now.
   *
   * Only addresses of components this install actually has. An engine nobody installed still has a target in
   * the catalog, and marking every vanilla row as shared with software that is not here would say nothing
   * about this install - the mark is worth having precisely because it distinguishes. An engine that IS
   * installed but has not written its settings is named and flagged instead of dropped: that link is real
   * and about to matter, and saying "also writes X" of a file ZAX is deliberately leaving alone would be a
   * lie in the other direction.
   */
  linkedTo(def: SettingDef, group?: string): ReadonlyArray<{ at: SettingTarget; live: boolean }> {
    if (def.targets.length < 2) return [];
    const here = this.targetFor(def, group);
    const live = liveTargets(def, this.contents);
    const present = (at: SettingTarget) => at.engine === undefined || this.engineDeployed[at.engine] !== undefined;
    return def.targets.filter((t) => t !== here && present(t)).map((at) => ({ at, live: live.includes(at) }));
  }

  targetFor(def: SettingDef, group?: string): SettingTarget {
    if (group === undefined) return ownTarget(def);
    return def.targets.find((t) => (t.engine ?? t.file) === group) ?? ownTarget(def);
  }

  gateOf(
    def: SettingDef,
    group?: string,
  ): { active: boolean; controller: SettingDef; wants: string; test: ValueTest } | null {
    // The gate of the address this row shows, not of the setting: a prerequisite can hold for one engine and
    // not the next, which is why the gate sits on the target at all. Fission refuses every enhancement while
    // its strict-vanilla switch is on, and says nothing about the same setting's sfall half.
    const gate = this.targetFor(def, group).gatedBy;
    if (!gate) return null;
    // Through `defOf` rather than the catalog alone: a mod setting may gate on a sibling of its own schema,
    // or across files on a catalog id - the manifest validator has already refused anything else.
    const controller = this.defOf(gate.id);
    if (!controller) return null;
    return {
      active: matchesValueTest(controller, this.valueOf(controller.id), gate),
      controller,
      wants: describeValueTest(controller, gate),
      test: gate,
    };
  }

  /**
   * Every setting that has to change before `def` takes effect, nearest first - or null where one of them
   * cannot be set from here: a value ZAX pins, a file this install does not have, a gate naming no single
   * value, or a cycle. Each controller's own gate is followed too, since setting one that is itself inert
   * writes a value the game goes on ignoring; the chain is what a one-click fix has to cover.
   */
  requirementsFor(def: SettingDef, group?: string): { def: SettingDef; value: string; wants: string }[] | null {
    const out: { def: SettingDef; value: string; wants: string }[] = [];
    // An array rather than a set: a chain runs to two or three links, and a set here would be a reactive one.
    const seen = [def.id];
    let current = def;
    for (;;) {
      // The same group all the way down: the layout holds a gate's controller to the tab the gated row is on,
      // so every link in a chain is an address of the component whose tab this is.
      const gate = this.gateOf(current, group);
      if (!gate || gate.active) return out;
      const controller = gate.controller;
      if (seen.includes(controller.id)) return null;
      seen.push(controller.id);
      if (controller.managed !== undefined || !this.hasFile(this.targetFor(controller, group).file)) return null;
      const value = valueSatisfying(controller, gate.test);
      if (value === undefined) return null;
      out.push({ def: controller, value, wants: gate.wants });
      current = controller;
    }
  }

  /**
   * Sets everything `def` waits on, as ordinary unsaved edits so save and revert behave as they do for a
   * typed one. The notice is not decoration: the settings changed can sit in another tab or another file,
   * where nothing on screen would otherwise show that anything happened.
   */
  satisfyGate(def: SettingDef, group?: string): void {
    const needed = this.requirementsFor(def, group);
    if (!needed || needed.length === 0) return;
    for (const requirement of needed) this.set(requirement.def.id, requirement.value);
    const first = needed[0];
    if (!first) return;
    this.notice =
      needed.length === 1
        ? { kind: "done", text: `Set ${first.def.label} to ${valueLabel(first.def, first.value)}.` }
        : { kind: "done", text: `Set ${needed.length} settings: ${needed.map((r) => r.def.label).join(", ")}.` };
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
    if (!(id in this.overrides)) return false;
    return this.split[id] === true || this.overrides[id] !== this.baselineOf(id);
  }

  set(id: string, value: string): void {
    // Dropped only where it would write nothing. A setting whose addresses disagree always has something to
    // write, even when the value matches the one address the control was showing.
    if (value === this.baselineOf(id) && this.split[id] !== true) {
      const { [id]: _dropped, ...rest } = this.overrides;
      this.overrides = rest;
      return;
    }
    this.overrides = { ...this.overrides, [id]: value };
    this.scheduleAutosave();
  }

  async revert(id: string): Promise<void> {
    const { [id]: _dropped, ...rest } = this.overrides;
    this.overrides = rest;
    await this.acceptReconciled([id]);
    this.scheduleAutosave();
  }

  async revertAll(): Promise<void> {
    // Pinned values are ZAX policy rather than a user edit, so reverting restores them instead of dropping them.
    this.overrides = this.managedOverrides();
    this.mods = this.modsBaseline;
    await this.acceptReconciled(Object.keys(this.reconciled));
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

  /** The order this install is judged against - the one its own project states, or the shared fallback. */
  private get recommendation(): readonly string[] {
    return this.install ? recommendationFor(this.install.type) : [];
  }

  /** The entries loading against ZAX's recommendation, which is both the warning and what a sort moves. */
  get againstRecommendation(): readonly string[] {
    return againstRecommendation(this.mods, this.recommendation);
  }

  /** Puts the mods the recommendation names in its order. Everything else keeps the place the user gave it. */
  sortMods(): void {
    this.mods = recommendedOrder(this.mods, this.recommendation);
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

  /** The entries pointing at nothing - what the row's own Forget drops one at a time. */
  get missingMods(): readonly Mod[] {
    return this.mods.filter((mod) => mod.kind === "missing");
  }

  /** The same drop for all of them at once, a folder that was cleared by hand leaving a line each. */
  forgetMissingMods(): void {
    this.mods = this.mods.filter((mod) => mod.kind !== "missing");
    this.scheduleAutosave();
  }

  /**
   * Where an install stands against the published mods. Apart from `run`: a flow that just installed or
   * removed refreshes from inside its own `run`, whose busy gate would refuse a nested one - and silently,
   * leaving the tab claiming the feeds were never read.
   *
   * The feeds themselves are not read here. What is deployed in a folder is the only thing a change of game
   * can change about an offer, and the backend holds one answer from the feeds for every install.
   */
  private async refreshModOffers(install: Install): Promise<void> {
    const request = ++this.standingRequest;
    this.modReads += 1;
    try {
      const standing = await backend.modInstallState(install);
      // Only the newest read for the game still on screen writes. A switch starts one off the `busy` gate, so
      // a slower earlier answer can still be out when it lands - and would arrive either on top of the answer
      // the Refresh button just fetched, or under a game that is no longer selected, forgetting it having
      // been dropped from the list among them.
      if (request === this.standingRequest && this.selectedInstall === install.path) this.modStanding = standing;
    } finally {
      this.modReads -= 1;
    }
  }

  /** What the feeds published. Once per run unless asked again, since no install changes the answer. */
  private async refreshModFeeds(refresh = false): Promise<void> {
    this.modReads += 1;
    try {
      this.modFeeds = await backend.publishedMods(refresh);
    } finally {
      this.modReads -= 1;
    }
  }

  /**
   * Both halves, for the first read and for the Mods tab's Refresh button - which is the one control that
   * asks the feeds again rather than be told what they said before.
   */
  async loadModOffers(refresh = false): Promise<void> {
    const install = this.install;
    if (!install) {
      this.modStanding = null;
      return;
    }
    await this.run("Reading the mod feeds", async () => {
      // In order rather than together: where an install stands is read against what the feeds last published,
      // so a refresh that replaces them has to land first - otherwise the tab draws the new set of mods
      // against an answer taken about the old one, and a mod the refresh added has nothing to say about it.
      await this.refreshModFeeds(refresh);
      await this.refreshModOffers(install);
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

  /**
   * Downloads and verifies a release, then holds its resolved plan up for the user's word. A release that
   * offers parts is asked about first, unless the record's choice carried over - which is what "an upgrade
   * re-installs the same choices without asking" means.
   */
  async prepareMod(
    offer: ModOffer,
    chosen?: readonly string[],
    answers?: Readonly<Record<string, string>>,
    version?: string,
  ): Promise<void> {
    const install = this.install;
    if (!install) return;
    const refusal = this.modFlowRefusal();
    if (refusal) {
      this.notice = refusal;
      return;
    }
    if (chosen === undefined && offer.choices?.ask) {
      this.modParts = { offer, chosen: offer.choices.selection, ...(version !== undefined ? { version } : {}) };
      return;
    }
    const parts = chosen ?? offer.choices?.selection;
    // After the choice rather than before it: what a release publishes is its own question, and the folders
    // on this machine are asked for once that is settled.
    if (answers === undefined && offer.asks?.length) {
      this.modInputs = { offer, chosen: parts ?? [], answers: {}, ...(version !== undefined ? { version } : {}) };
      return;
    }
    const wanted = version ?? offer.version;
    await this.run(
      `Preparing ${offer.name} ${wanted}`,
      async () => {
        const plan = await backend.planMod(install, offer.id, parts, answers, version);
        this.modPlan = { offer, plan, version: wanted };
        return null;
      },
      { id: offer.id, action: "prepare" },
    );
  }

  /**
   * The versions a row could install instead of the one its button names, once the list has arrived. Held for
   * one row at a time, which is all the dialog shows.
   */
  modVersionPick = $state<{ offer: ModOffer; versions: readonly string[]; read: boolean } | null>(null);

  /**
   * Opens that choice. What the install already carries goes with the request where it is a floor, so the
   * answer is the versions it could move to.
   *
   * Only a base mod has one: its own installer has no way back down, so an older release is not something to
   * offer. Anything that is files in the mods folder takes an older release the same way it takes a newer one,
   * and asking with no floor is what puts those in the list. The type that decides is the one on disk, which a
   * conversion states separately - the offered release's is the type it would become.
   */
  async chooseModVersion(offer: ModOffer): Promise<void> {
    const state = offer.availability;
    const onDisk = state.kind === "convert" ? state.was : offer.type;
    const held =
      onDisk === "base" && (state.kind === "upgrade" || state.kind === "downgrade" || state.kind === "convert")
        ? state.from
        : undefined;
    this.modVersionPick = { offer, versions: [], read: false };
    await this.run(`Reading the ${offer.name} versions`, async () => {
      try {
        const versions = await backend.modVersions(offer.id, held);
        // The dialog may have been dismissed, or another row's opened, while the list was on its way.
        if (this.modVersionPick?.offer.id === offer.id) this.modVersionPick = { offer, versions, read: true };
      } catch (error) {
        // Closed rather than left saying "reading": the notice `run` raises carries the reason, and a dialog
        // still claiming to be loading a list that will never arrive is the one state worse than no dialog.
        if (this.modVersionPick?.offer.id === offer.id) this.modVersionPick = null;
        throw error;
      }
      return null;
    });
  }

  dismissModVersion(): void {
    this.modVersionPick = null;
  }

  /**
   * Opens the shell's picker for one of a mod's questions, and keeps what comes back.
   *
   * Aimed at the file the answer has to hold rather than at the folder: what the user is looking for is a copy
   * of another game, and `master.dat` is the thing on screen that says they have found it.
   */
  async browseForModInput(id: string): Promise<void> {
    const held = this.modInputs;
    if (!held) return;
    const asked = held.offer.asks?.find((one) => one.id === id);
    const chosen = await backend.chooseFolder(asked?.holds);
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

  /**
   * Ticks or unticks one part. A `one` group's other options go off with it, which is what makes it one, and
   * so does anything that needs what was just unticked - a selection the install would only refuse is not a
   * state to let the dialog sit in.
   */
  setModPart(id: string, on: boolean): void {
    const held = this.modParts;
    const groups = held?.offer.choices?.groups;
    if (!held || !groups) return;
    const group = groups.find((one) => one.options.some((option) => option.id === id));
    if (!group) return;
    const cleared = group.pick === "one" ? group.options.map((option) => option.id) : [id];
    let chosen = held.chosen.filter((picked) => !cleared.includes(picked));
    if (on) chosen = [...chosen, id];

    const options = groups.flatMap((one) => one.options);
    for (;;) {
      const kept = chosen.filter((picked) => {
        const needs = options.find((option) => option.id === picked)?.needs;
        return needs === undefined || chosen.includes(needs);
      });
      if (kept.length === chosen.length) break;
      chosen = kept;
    }
    this.modParts = { offer: held.offer, chosen, ...(held.version !== undefined ? { version: held.version } : {}) };
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
    const install = this.install;
    this.modPlan = null;
    if (!held || !install) return;
    await this.run(
      `Installing ${held.offer.name} ${held.version}`,
      async () => {
        // The plan's own fingerprint, so what runs is what was on screen: the install re-plans, and one
        // that now resolves differently comes back as a refusal to look again rather than as a surprise.
        // The plan's own choices and folders, not the dialogs': what runs is what the resolved plan said it
        // would, down to which folder it reads from.
        const chosen =
          held.plan.kind === "base"
            ? held.plan.components
            : held.plan.kind === "stacking"
              ? held.plan.parts
              : undefined;
        const answers = held.plan.kind === "creates" ? held.plan.inputs : undefined;
        const outcome = await backend.installMod(
          install,
          held.offer.id,
          held.plan.fingerprint,
          chosen,
          answers,
          held.version === held.offer.version ? undefined : held.version,
        );
        // A mod that created an install is a second game to manage. Registered through the same path the Add
        // button takes, so what it is comes from reading the directory rather than from what the manifest
        // claimed it would make - and a refusal there is reported rather than swallowed. Not through
        // `addInstall`, which opens an operation of its own and this one is already running.
        const added = "created" in outcome ? await this.registerInstall(outcome.created) : null;
        // A base install makes this a different game, and nothing but the directory knows that: the stored
        // type came from a reading taken before the installer ran.
        if ("becomes" in outcome) await this.reidentify(install.path);
        await this.readInstall();
        await this.refreshModOffers(install);
        if (added?.kind === "problem") return added;
        const conflicts =
          outcome.conflicts.length > 0
            ? ` ${outcome.conflicts.length} setting(s) you had changed were kept over the release's new defaults.`
            : "";
        const beside = "created" in outcome ? ` ${outcome.created} is now on the list of installations.` : "";
        const skipped = "skipped" in outcome && outcome.skipped.length > 0 ? ` ${skippedText(outcome.skipped)}` : "";
        return {
          kind: "done",
          text: `${held.offer.name} ${outcome.version} installed.${conflicts}${beside}${skipped}`,
        };
      },
      { id: held.offer.id, action: "install" },
    );
  }

  /**
   * Re-reads what kind of game sits at a path and stores it. Only a base install changes the answer, and it
   * is what makes the install's name and badge follow what was just done to it.
   */
  private async reidentify(path: string): Promise<void> {
    const type = await backend.identifyInstall(path);
    if (type === null) return;
    this.installs = this.installs.map((one) => (one.path === path ? { ...one, type } : one));
    await this.persist();
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
    await this.run(
      `Removing ${offer.name}`,
      async () => {
        await backend.removeMod(install, offer.id);
        await this.readInstall();
        await this.refreshModOffers(install);
        return { kind: "done", text: `${offer.name} removed. Copies are in the backup folder.` };
      },
      { id: offer.id, action: "remove" },
    );
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
    await this.run(
      `Restoring before ${offer.name}`,
      async () => {
        await backend.restoreMod(install, offer.id);
        await this.readInstall();
        await this.refreshModOffers(install);
        return { kind: "done", text: `The install is back to what it was before ${offer.name}.` };
      },
      { id: offer.id, action: "restore" },
    );
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
    this.settingsTab = place.group;
    this.fileTab = { ...this.fileTab, [place.group]: place.tab };
    this.query = "";
  }

  /** Unsaved edits belonging to one config file, for the dot on its settings tab. */
  /**
   * The groups of settings tabs to offer, in the layout's order: the game's own three always, and an engine's
   * only where that engine is installed here. A tab for an engine nobody has is a screen of controls that
   * write a file the game will never read.
   *
   * An installed engine that has not yet written its settings is offered but refused, with the reason. Its
   * config does not exist until it has run once, and filling one in from the catalog's own defaults would
   * hand the engine a configuration the user never chose - so the honest answer is to say what to do.
   */
  get settingsGroups(): ReadonlyArray<SettingsGroup> {
    return LAYOUT.flatMap((group): SettingsGroup[] => {
      if (group.engine === undefined) return [{ group, refusal: null }];
      const engine = ENGINES.find((one) => one.id === group.engine);
      if (engine === undefined || this.engineDeployed[group.engine] === undefined) return [];
      if (hasMintedSettings(engine, this.contents)) return [{ group, refusal: null }];
      return [{ group, refusal: `Run the game once with ${engine.short} - it writes these settings itself.` }];
    });
  }

  /** Whether a group's rows accept input: the tab is reachable while its settings are not yet writable. */
  groupRefusal(group: string): string | null {
    return this.settingsGroups.find((one) => one.group.id === group)?.refusal ?? null;
  }

  modifiedInGroup(group: string): number {
    // By the addresses the group shows rather than by the setting's own one: an edit to a setting an engine
    // shares is unsaved on that engine's tab too, and a dot only over the component that minted the id would
    // leave the other tab looking clean while its own row is changed.
    return SETTINGS.filter((s) => s.targets.some((t) => (t.engine ?? t.file) === group) && this.isModified(s.id))
      .length;
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

  /**
   * Opens the shell's picker and adds what comes back. Cancelling adds nothing and says nothing.
   *
   * Aimed at `fallout2.exe`, which is the one file `detectGameType` requires of every install it recognises:
   * a folder picker leaves the user guessing which of several similar-looking folders is the game, and the
   * folder around that file is by construction one this will not then refuse.
   */
  async browseForInstall(): Promise<void> {
    const chosen = await backend.chooseFolder(INSTALL_MARKER);
    if (chosen !== null) await this.addInstall(chosen);
  }

  /** Whether the selected install has this config file at all. Unknown until the first read finishes. */
  hasFile(file: string): boolean {
    return this.contents[file] !== undefined;
  }

  /** Adds a directory the user pointed at, refusing one that does not hold a game. */
  async addInstall(path: string): Promise<void> {
    await this.run("Adding the install", () => this.registerInstall(path));
  }

  /**
   * The registration itself, without an operation around it: an install ZAX has just created is added from
   * inside the operation that made it, which is already the running one.
   */
  private async registerInstall(path: string): Promise<Notice | null> {
    const trimmed = path.trim();
    if (trimmed === "") return null;
    const type = await backend.identifyInstall(trimmed);
    if (type === null) return { kind: "problem", text: `${trimmed} does not hold a Fallout 2 install.` };
    const result = addInstall(this.installs, newInstall(trimmed, type));
    if (!result.ok) return { kind: "problem", text: result.reason };
    this.installs = result.installs;
    await this.persist();
    if (this.selectedInstall === "") await this.selectInstall(trimmed);
    return { kind: "done", text: `Added ${trimmed}.` };
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
      const def = this.defOf(id) ?? this.discovered.find((s) => s.id === id);
      if (!def) continue;
      // Every address the setting has that is actually writable here - one edit, one value, however many
      // names the installed engines keep it under. `liveTargets` is what leaves a dormant engine's alone.
      for (const at of liveTargets(def, this.contents)) {
        out.push({ file: at.file, section: at.section, key: at.key, value });
      }
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

  /**
   * Starts the game, through an engine when one is named and the original executable otherwise. `published`
   * names the build to run, or null to follow what the folder holds and what the cache offers.
   */
  async play(engineId: string | null = null, published: string | null = null): Promise<void> {
    const install = this.install;
    if (!install) return;
    const engine = engineId === null ? null : this.engines.find((one) => one.id === engineId);
    await this.run(engine ? `Starting the game in ${engine.short}` : "Starting the game", async () => {
      await backend.launch(install, this.sfallInstalled, engineId, published);
      // The launch may have deployed a different build here, or moved the pin; the chooser's tick reads both.
      if (engineId !== null) await this.readInstall();
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

  /** Rereads which builds this machine holds. Cheap - the catalog and a directory listing, no network. */
  private async readMachineEngines(): Promise<void> {
    this.engines = await backend.machineEngines();
  }

  /** What one engine has published, for the button that asks again after the startup check. */
  async checkEngine(engineId: string): Promise<void> {
    const engine = this.engines.find((one) => one.id === engineId);
    await this.run(`Checking for a newer ${engine?.short ?? "engine"}`, async () => {
      const [newest] = await backend.engineReleases(engineId);
      if (newest) this.engineLatest = { ...this.engineLatest, [engineId]: newest };
      return null;
    });
  }

  /** Downloads a build into the machine's cache. Nothing reaches a game folder until one runs it. */
  async fetchEngine(engineId: string, published: string | null = null): Promise<void> {
    const engine = this.engines.find((one) => one.id === engineId);
    await this.run(`Fetching ${engine?.name ?? "the engine"}`, async () => {
      const release = await backend.fetchEngine(engineId, published);
      await this.readMachineEngines();
      return { kind: "done", text: `${engine?.name ?? engineId} ${release.release} is ready to run.` };
    });
  }

  /** Drops one build from the cache. A folder already running it keeps the copy it holds. */
  async forgetEngine(engineId: string, published: string): Promise<void> {
    const engine = this.engines.find((one) => one.id === engineId);
    await this.run(`Removing ${engine?.name ?? "the engine"}`, async () => {
      await backend.forgetEngine(engineId, published);
      await this.readMachineEngines();
      return null;
    });
  }

  /** The builds this machine holds for an engine, newest first. */
  engineVersions(engineId: string): readonly CachedBuild[] {
    return this.engines.find((one) => one.id === engineId)?.versions ?? [];
  }

  /** Whether the deployed build is behind what was found - false until someone has checked, or nothing is. */
  engineOutdated(engineId: string): boolean {
    const deployed = this.engineDeployed[engineId];
    const latest = this.engineLatest[engineId];
    if (!deployed || !latest) return false;
    return engineOutdated(engineById(engineId), deployed, latest);
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

  async wipe(which: WipeTarget): Promise<void> {
    await this.run(which === "log" ? "Clearing the log" : "Emptying the directory", async () => {
      await backend.wipe(which);
      return { kind: "done", text: which === "log" ? "Cleared the log." : `Emptied the ${which} directory.` };
    });
  }
}

export const store = new Store();
export { SETTINGS, isPreview };
