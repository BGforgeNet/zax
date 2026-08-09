/**
 * A setting's typed definition. One object drives parsing, validation, rendering, search and diffing.
 *
 * `id` is deliberately independent of file/section/key: saved profiles and presets store ids, so an upstream
 * rename of a config key does not invalidate user data.
 */

export interface ChoiceOption {
  value: string;
  label: string;
  help?: string;
}

export type SettingKind =
  /** Raw engine scale (volumes run 0..32767) shown to the user as a percentage. */
  | { type: "scale"; max: number }
  | { type: "bool"; onValue: string; offValue: string }
  /** `sentinels` name values that are not quantities - 0 meaning "native", -1 meaning "auto". */
  | { type: "int"; min?: number; max?: number; unit?: string; sentinels?: Readonly<Record<string, string>> }
  | { type: "float"; min?: number; max?: number; unit?: string; sentinels?: Readonly<Record<string, string>> }
  | { type: "text"; path?: boolean }
  | { type: "choice"; options: ReadonlyArray<ChoiceOption> }
  | { type: "key" };

/**
 * Which values of a setting a rule applies to. `isNot` covers controllers with an open range, where the
 * interesting states cannot be listed: "a key is bound" is every value but none, and "idling is on" is every
 * value but the disabled sentinel.
 */
export type ValueTest = { is: readonly string[] } | { isNot: readonly string[] };

/** Whether a value satisfies a test. Absent and blank never do - nothing is not "some other value". */
export function matchesValueTest(def: SettingDef, value: string | undefined, test: ValueTest): boolean {
  if (value === undefined || value.trim() === "") return false;
  // sfall writes some bindings in hex, so an unbound key reads as 0x0 in one file and 0 in the next.
  const raw = def.kind.type === "key" ? parseScancode(value) : value;
  return "is" in test ? test.is.includes(raw) : !test.isNot.includes(raw);
}

/** The values a test accepts, phrased for a note: "DX9 fullscreen or DX9 windowed", "anything but Disabled". */
export function describeValueTest(def: SettingDef, test: ValueTest): string {
  // A sentinel is what the raw number means, and these values are almost always sentinels.
  const name = (v: string) => sentinelLabel(def, v) ?? displayValue(def, v);
  if ("is" in test) return test.is.map(name).join(" or ");
  if (def.kind.type === "key") return "a key";
  return `anything but ${test.isNot.map(name).join(" or ")}`;
}

export interface SettingDef {
  id: string;
  file: string;
  section: string;
  key: string;
  kind: SettingKind;
  label: string;
  help?: string;
  /**
   * This setting only takes effect while another one passes the test. Editing it otherwise changes the file but
   * not the game, so the interface says so rather than letting the change look effective.
   */
  gatedBy?: { id: string } & ValueTest;
  /**
   * A pairing the engine handles badly, warned about only while both settings are in the states named. Unlike a
   * gate, each setting still works alone, so neither is disabled.
   */
  conflictsWith?: { id: string; self: ValueTest; other: ValueTest; note: string };
  /**
   * ZAX owns this value and always writes it. Shown read-only with the reason, rather than hidden, so the
   * choice is visible instead of looking like the setting simply went missing.
   */
  managed?: { value: string; reason: string };
}

/** Raw config value -> percentage, for scale kinds. */
export function scaleToPercent(raw: string, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / max) * 100);
}

/** Percentage -> raw config value, rounded to the engine's own integer scale. */
export function percentToScale(percent: number, max: number): string {
  return String(Math.round((Math.min(100, Math.max(0, percent)) / 100) * max));
}

/** sfall writes some key bindings in hex; the game's own settings use decimal. */
export function parseScancode(raw: string): string {
  const trimmed = raw.trim();
  if (/^0x[0-9a-f]+$/i.test(trimmed)) return String(parseInt(trimmed, 16));
  return trimmed;
}

/** DirectX scancodes, for settings that bind a key. 0 means unbound. */
export const KEY_BY_SCANCODE: Readonly<Record<string, string>> = {
  "0": "None",
  "2": "1",
  "3": "2",
  "4": "3",
  "5": "4",
  "6": "5",
  "7": "6",
  "8": "7",
  "9": "8",
  "10": "9",
  "12": "-",
  "13": "=",
  "16": "Q",
  "17": "W",
  "18": "E",
  "19": "R",
  "20": "T",
  "21": "Y",
  "22": "U",
  "23": "I",
  "24": "O",
  "25": "P",
  "30": "A",
  "31": "S",
  "32": "D",
  "33": "F",
  "34": "G",
  "35": "H",
  "36": "J",
  "37": "K",
  "38": "L",
  "39": ";",
  "40": "'",
  "41": "`",
  "43": "\\",
  "44": "Z",
  "45": "X",
  "46": "C",
  "47": "V",
  "48": "B",
  "49": "N",
  "50": "M",
  "51": ",",
  "52": ".",
  "53": "/",
};

export const SCANCODE_BY_KEY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(KEY_BY_SCANCODE).map(([code, name]) => [name, code]),
);

/** Name for a value that is a sentinel rather than a quantity, e.g. 0 meaning "native resolution". */
export function sentinelLabel(def: SettingDef, raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const kind = def.kind;
  if (kind.type !== "int" && kind.type !== "float") return undefined;
  return kind.sentinels?.[raw];
}

/** Human-readable rendering of a raw config value, for display and for search. */
export function displayValue(def: SettingDef, raw: string | undefined): string {
  if (raw === undefined) return "";
  switch (def.kind.type) {
    case "bool":
      return raw === def.kind.onValue ? "On" : "Off";
    case "choice":
      return def.kind.options.find((o) => o.value === raw)?.label ?? raw;
    case "key":
      return KEY_BY_SCANCODE[parseScancode(raw)] ?? raw;
    case "scale":
      return `${scaleToPercent(raw, def.kind.max)}%`;
    case "int":
    case "float":
      return def.kind.unit ? `${raw} ${def.kind.unit}` : raw;
    default:
      return raw;
  }
}

/**
 * The text a search matches against - the fields a user would plausibly type, lowercased once so callers can
 * index it ahead of time instead of rebuilding it per query.
 *
 * `group` is deliberately excluded. It labels the source component ("High resolution"), so including it made
 * every one of that file's settings match a search for "resolution" - a whole file of noise burying the handful
 * of settings actually about resolution. `file` already covers searching by origin.
 */
export function searchText(def: SettingDef): string {
  const fields = [def.label, def.key, def.section, def.file, def.help ?? ""];
  if (def.kind.type === "choice") fields.push(...def.kind.options.map((o) => o.label));
  return fields.join(" ").toLowerCase();
}
