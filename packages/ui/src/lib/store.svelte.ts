import {
  IniDocument,
  describeValueTest,
  isApplied,
  matchesValueTest,
  removeInstall,
  withWine,
  type Action,
  type Install,
  type SettingDef,
  type Theme,
  type ValueTest,
  type WineConfig,
} from "@zax/core";
import { ACTIONS, CONFIG_FILES, SETTINGS, describePlace, hiddenIds, placesById, type Place } from "@zax/fallout2";

// Built once: the layout does not change at runtime, and every search result needs a lookup in it.
const PLACES = placesById();
const HIDDEN = hiddenIds();

import fallout2cfg from "../../../../fixtures/vanilla-f2up/fallout2.cfg?raw";
import f2resini from "../../../../fixtures/vanilla-f2up/f2_res.ini?raw";
import ddrawini from "../../../../fixtures/vanilla-f2up/ddraw.ini?raw";

const SOURCE: Record<string, string> = {
  "fallout2.cfg": fallout2cfg,
  "f2_res.ini": f2resini,
  "ddraw.ini": ddrawini,
};

/** Value a setting has on disk, before any edit. Undefined when the install has never written the key. */
function readBaseline(): Record<string, string | undefined> {
  const docs = Object.fromEntries(CONFIG_FILES.map((f) => [f, IniDocument.parse(SOURCE[f] ?? "")]));
  return Object.fromEntries(SETTINGS.map((s) => [s.id, docs[s.file]?.get(s.section, s.key)]));
}

const baseline = readBaseline();

const CURATED = new Map(SETTINGS.map((s) => [`${s.file}|${s.section}|${s.key}`.toLowerCase(), s]));

/**
 * Every key the config files actually contain. The catalog curates 166 of them; sfall's ddraw.ini alone holds
 * 115 keys, most undocumented by the catalog but documented by its own inline comments, which become the help
 * text for free.
 */
function discover(): SettingDef[] {
  const out: SettingDef[] = [];
  for (const file of CONFIG_FILES) {
    const doc = IniDocument.parse(SOURCE[file] ?? "");
    doc.entries().forEach((entry) => {
      const curated = CURATED.get(`${file}|${entry.section}|${entry.key}`.toLowerCase());
      if (curated) {
        out.push(curated);
        return;
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
    });
  }
  return out;
}

/**
 * Values ZAX pins regardless of what the file says. UAC_AWARE=1 makes the high-resolution patch read its
 * settings from roaming appdata instead of the game folder, so leaving it on means editing an ini the patch
 * never reads. They start as pending changes so the user sees them rather than having them applied invisibly.
 */
function managedOverrides(): Record<string, string> {
  const docs = Object.fromEntries(CONFIG_FILES.map((f) => [f, IniDocument.parse(SOURCE[f] ?? "")]));
  const out: Record<string, string> = {};
  for (const s of SETTINGS) {
    if (!s.managed) continue;
    if (docs[s.file]?.get(s.section, s.key) !== s.managed.value) out[s.id] = s.managed.value;
  }
  return out;
}

const DISCOVERED = discover();
const RAW_BASELINE: Record<string, string | undefined> = Object.fromEntries(
  DISCOVERED.map((s) => [s.id, IniDocument.parse(SOURCE[s.file] ?? "").get(s.section, s.key)]),
);

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

/**
 * The install the preview edits: the vendored fixture, which is a real GOG install's config files with the
 * unofficial patch applied. Named for what it actually is - a plausible-looking home directory would be a
 * fabricated path that reads as a real install nobody has.
 *
 * Scanning and adding need to read directories, so until the platform layer exists the list cannot grow. What
 * acts on the list rather than on the filesystem - selecting, removing, wine settings - runs for real.
 */
const PREVIEW_INSTALLS: readonly Install[] = [
  { path: "fixtures/vanilla-f2up", type: "fallout2upu" },
];

/**
 * Wine only exists off Windows, matching the previous implementation, which hid the whole tab there. The
 * browser reports the machine it runs on, which for the desktop build is the machine that matters.
 */
function onWindows(): boolean {
  return typeof navigator !== "undefined" && /win/i.test(navigator.userAgent);
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
  installs = $state<readonly Install[]>(PREVIEW_INSTALLS);
  selectedInstall = $state<string>(PREVIEW_INSTALLS[0]?.path ?? "");
  theme = $state<Theme>("system");
  overrides = $state<Record<string, string>>(managedOverrides());

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
    return id in baseline ? baseline[id] : RAW_BASELINE[id];
  }

  valueOf(id: string): string | undefined {
    return id in this.overrides ? this.overrides[id] : this.baselineOf(id);
  }

  /**
   * The key is not in the config file at all - usually because the installed component predates it. The engine
   * falls back to its own built-in default, so this is not the same as an empty value.
   */
  defOf(id: string): SettingDef | undefined {
    return SETTINGS.find((s) => s.id === id);
  }

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
    this.overrides = managedOverrides();
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

  get wineAvailable(): boolean {
    return !onWindows();
  }

  selectInstall(path: string): void {
    this.selectedInstall = path;
  }

  removeInstall(path: string): void {
    this.installs = removeInstall(this.installs, path);
    // Dropping the selected install would leave every settings view bound to something no longer listed.
    if (this.selectedInstall === path) this.selectedInstall = this.installs[0]?.path ?? "";
  }

  setWine(path: string, wine: WineConfig): void {
    this.installs = withWine(this.installs, path, wine);
  }

}

export const store = new Store();
export { DISCOVERED, SETTINGS };
