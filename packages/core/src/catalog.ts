/**
 * A setting's typed definition. One object drives parsing, validation, rendering, search and diffing.
 *
 * `id` joins the catalog to layout, actions and search. Its first address mints it; later targets keep it.
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

/**
 * A value that would make `test` pass, or undefined where it names none to write - "any key but 0" is every
 * key, and picking one would rebind the user's keyboard on their behalf. Where several pass, the first the
 * test lists: a gate naming a range states them in the order its author meant them to be read.
 */
export function valueSatisfying(def: SettingDef, test: ValueTest): string | undefined {
  if ("is" in test) return test.is[0];
  // Only a kind whose values can be listed has a complement to offer; a number or a key has an open range.
  const kind = def.kind;
  const listed =
    kind.type === "bool"
      ? [kind.onValue, kind.offValue]
      : kind.type === "choice"
        ? kind.options.map((option) => option.value)
        : [];
  return listed.find((value) => !test.isNot.includes(value));
}

/** What a value is called in the interface: its sentinel name where it has one, since that is what it means. */
export function valueLabel(def: SettingDef, raw: string): string {
  return sentinelLabel(def, raw) ?? displayValue(def, raw);
}

/** The values a test accepts, phrased for a note: "DX9 fullscreen or DX9 windowed", "anything but Disabled". */
export function describeValueTest(def: SettingDef, test: ValueTest): string {
  const name = (v: string) => valueLabel(def, v);
  if ("is" in test) return test.is.map(name).join(" or ");
  if (def.kind.type === "key") return "a key";
  return `anything but ${test.isNot.map(name).join(" or ")}`;
}

/**
 * One address a setting's value lives at. Most settings have a single target; a setting that more than one
 * engine carries under its own name has one per engine, so that the several names stay one row.
 */
export interface SettingTarget {
  file: string;
  section: string;
  key: string;
  /**
   * The engine whose settings this address belongs to, absent where it is the game's own, sfall's or the
   * high-resolution patch's. Not something the file and section imply: fallout2-ce writes keys of its own
   * into the game's `[system]` and `[sound]`, beside vanilla keys that belong to no engine.
   */
  engine?: string;
  /**
   * This target only takes effect while another setting passes the test. Editing it otherwise changes the file
   * but not the game, so the interface says so rather than letting the change look effective. Per target
   * rather than per setting: a prerequisite can hold on one engine and not on the next, and a shared gate
   * would either over-restrict the others or write a value that silently does nothing.
   */
  gatedBy?: { id: string } & ValueTest;
}

export interface SettingDef {
  id: string;
  /**
   * Every address this one value is written to, the nominated one first - that is the address the id was
   * minted from, so it stays the id's source even where its file is absent. Typed as a non-empty list so
   * that the nominated target is reachable without an assertion.
   */
  targets: readonly [SettingTarget, ...SettingTarget[]];
  kind: SettingKind;
  label: string;
  help?: string;
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

/** A setting's own address: the target its id was minted from, which every setting has exactly one of. */
export function ownTarget(def: SettingDef): SettingTarget {
  return def.targets[0];
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

/**
 * Every scancode sfall's own dik.h defines: what to call it, and the DOM `code` that produces it where a
 * browser can. One table rather than two maps, so a key the capture control can set is always one the
 * display can name - a scancode with no name here renders as a bare number.
 */
const KEYS: readonly (readonly [scancode: number, name: string, domCode?: string])[] = [
  [0, "None"],
  [1, "Esc", "Escape"],
  [2, "1", "Digit1"],
  [3, "2", "Digit2"],
  [4, "3", "Digit3"],
  [5, "4", "Digit4"],
  [6, "5", "Digit5"],
  [7, "6", "Digit6"],
  [8, "7", "Digit7"],
  [9, "8", "Digit8"],
  [10, "9", "Digit9"],
  [11, "0", "Digit0"],
  [12, "-", "Minus"],
  [13, "=", "Equal"],
  [14, "Backspace", "Backspace"],
  [15, "Tab", "Tab"],
  [16, "Q", "KeyQ"],
  [17, "W", "KeyW"],
  [18, "E", "KeyE"],
  [19, "R", "KeyR"],
  [20, "T", "KeyT"],
  [21, "Y", "KeyY"],
  [22, "U", "KeyU"],
  [23, "I", "KeyI"],
  [24, "O", "KeyO"],
  [25, "P", "KeyP"],
  [26, "[", "BracketLeft"],
  [27, "]", "BracketRight"],
  [28, "Enter", "Enter"],
  [29, "Left Ctrl", "ControlLeft"],
  [30, "A", "KeyA"],
  [31, "S", "KeyS"],
  [32, "D", "KeyD"],
  [33, "F", "KeyF"],
  [34, "G", "KeyG"],
  [35, "H", "KeyH"],
  [36, "J", "KeyJ"],
  [37, "K", "KeyK"],
  [38, "L", "KeyL"],
  [39, ";", "Semicolon"],
  [40, "'", "Quote"],
  [41, "`", "Backquote"],
  [42, "Left Shift", "ShiftLeft"],
  [43, "\\", "Backslash"],
  [44, "Z", "KeyZ"],
  [45, "X", "KeyX"],
  [46, "C", "KeyC"],
  [47, "V", "KeyV"],
  [48, "B", "KeyB"],
  [49, "N", "KeyN"],
  [50, "M", "KeyM"],
  [51, ",", "Comma"],
  [52, ".", "Period"],
  [53, "/", "Slash"],
  [54, "Right Shift", "ShiftRight"],
  [55, "Numpad *", "NumpadMultiply"],
  [56, "Left Alt", "AltLeft"],
  [57, "Space", "Space"],
  [58, "Caps Lock", "CapsLock"],
  [59, "F1", "F1"],
  [60, "F2", "F2"],
  [61, "F3", "F3"],
  [62, "F4", "F4"],
  [63, "F5", "F5"],
  [64, "F6", "F6"],
  [65, "F7", "F7"],
  [66, "F8", "F8"],
  [67, "F9", "F9"],
  [68, "F10", "F10"],
  [69, "Num Lock", "NumLock"],
  [70, "Scroll Lock", "ScrollLock"],
  [71, "Numpad 7", "Numpad7"],
  [72, "Numpad 8", "Numpad8"],
  [73, "Numpad 9", "Numpad9"],
  [74, "Numpad -", "NumpadSubtract"],
  [75, "Numpad 4", "Numpad4"],
  [76, "Numpad 5", "Numpad5"],
  [77, "Numpad 6", "Numpad6"],
  [78, "Numpad +", "NumpadAdd"],
  [79, "Numpad 1", "Numpad1"],
  [80, "Numpad 2", "Numpad2"],
  [81, "Numpad 3", "Numpad3"],
  [82, "Numpad 0", "Numpad0"],
  [83, "Numpad .", "NumpadDecimal"],
  [87, "F11", "F11"],
  [88, "F12", "F12"],
  [141, "Numpad ="],
  [145, "@"],
  [146, ":"],
  [147, "_"],
  [149, "Stop"],
  [150, "AX"],
  [151, "Unlabeled"],
  [156, "Numpad Enter", "NumpadEnter"],
  [157, "Right Ctrl", "ControlRight"],
  [179, "Numpad ,"],
  [181, "Numpad /", "NumpadDivide"],
  [183, "Print Screen", "PrintScreen"],
  [184, "Right Alt", "AltRight"],
  [199, "Home", "Home"],
  [200, "Up", "ArrowUp"],
  [201, "Page Up", "PageUp"],
  [203, "Left", "ArrowLeft"],
  [205, "Right", "ArrowRight"],
  [207, "End", "End"],
  [208, "Down", "ArrowDown"],
  [209, "Page Down", "PageDown"],
  [210, "Insert", "Insert"],
  [211, "Delete", "Delete"],
  [219, "Left Win", "MetaLeft"],
  [220, "Right Win", "MetaRight"],
  [221, "Menu", "ContextMenu"],
];

/** DirectX scancodes, for settings that bind a key. 0 means unbound. */
export const KEY_BY_SCANCODE: Readonly<Record<string, string>> = Object.fromEntries(
  KEYS.map(([scancode, name]) => [String(scancode), name]),
);

/**
 * What a captured keypress writes. Keyed by `KeyboardEvent.code` rather than `key` because a scancode is
 * the physical key: `key` carries the layout, so the same code would mean two different scancodes.
 */
export const SCANCODE_BY_DOM_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  KEYS.flatMap(([scancode, , domCode]) => (domCode === undefined ? [] : [[domCode, String(scancode)]])),
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
  const addresses = def.targets.flatMap((t) => [t.key, t.section, t.file]);
  const fields = [def.label, ...addresses, def.help ?? ""];
  if (def.kind.type === "choice") fields.push(...def.kind.options.map((o) => o.label));
  return fields.join(" ").toLowerCase();
}
