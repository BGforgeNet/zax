/**
 * Converts the previous implementation's format definitions into the typed catalog.
 * Run from the repo root: node scripts/gen/gen-catalog.mjs
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { idFor } from "./ids.mjs";
// yaml is @zax/core's dependency; the repo root carries none of its own, so resolve it through that package.
const YAML = createRequire(new URL("../../packages/core/", import.meta.url))("yaml");

const FILES = ["fallout2.cfg", "f2_res.ini", "ddraw.ini"];

// Category assignment. Default is per (file, section); the overrides below are per key, because a few sections
// (notably ddraw's Misc, which holds 42 unrelated settings) are grab-bags rather than topics.
// Frames from the previous UI supply the sub-heading. Labels like "Art" and "Orientation" were written to be
// read inside one, so dropping the frame strands them. Where a setting had no frame, fall back to its tab.
// Engine scales shown as percentages, with the raw maximum the engine uses.
const SCALE_MAX = {
  master_volume: 32767,
  music_volume: 32767,
  sndfx_volume: 32767,
  speech_volume: 32767,
};

// Units the label used to carry inline, or omitted entirely.
/*
  Only units the source states. Six more were dropped as unsupported guesses of mine: KB on the two caches and
  MB on the art cache, which the source calls only "Presumably, the buffer size", and ms on the three panel
  animation delays, which it calls only "animation time". A unit reads as a fact about the field, so an
  incomplete one beats a wrong one - the same mistake as labelling a fade duration a percentage.
*/
const UNIT = {
  WorldMapDelay2: "ms",
  ProcessorIdle: "ms",
  MENU_BG_OFFSET_X: "px",
  MENU_BG_OFFSET_Y: "px",
  IFACE_BAR_WIDTH: "px",
  GraphicsWidth: "px",
  GraphicsHeight: "px",
  SCR_WIDTH: "px",
  SCR_HEIGHT: "px",
  SPLASH_SCRN_TIME: "s",
  CorpseDeleteTime: "days",
  REFRESH_RATE: "Hz",
  // fallout2-ce shifts these before use - `cacheSize << 10` and `cacheSize << 20` - and its own error text for
  // the sound cache says "expressed in K".
  cache_size: "KB",
  art_cache_size: "MB",
  SpeedMultiInitial: "%",
  WorldMapTimeMod: "%",
  FadeMultiplier: "%",
};

// Sound-card IRQ/DMA/port date from ISA hardware; they are noise on any modern install.
// Sanitization. The previous bounds were spinner ranges, not domains - a graphics width of 1 passed. Where a
// value has a magic meaning it becomes a named sentinel rather than a bare number the user has to decode.
const NUMERIC = {
  GraphicsWidth: { min: 640, sentinels: { 0: "Native" } },
  GraphicsHeight: { min: 480, sentinels: { 0: "Native" } },
  REFRESH_RATE: { min: 24, max: 300, sentinels: { 0: "Driver default" } },
  ProcessorIdle: { min: 0, sentinels: { "-1": "Disabled" } },
  ReloadReserve: { min: 0, sentinels: { "-1": "Disabled (vanilla behaviour)" } },
  dma: { min: 0, sentinels: { "-1": "Auto-detect" } },
  irq: { min: 0, sentinels: { "-1": "Auto-detect" } },
  port: { min: 0, sentinels: { "-1": "Auto-detect" } },
  art_cache_size: { min: 1 },
  NumPathNodes: { min: 1 },
  cache_size: { min: 1, max: 262143 },
  splash: { min: 0, max: 9 },
  // The engine's own constant, rather than the 6-decimal rounding the config file writes.
  brightness: { min: 1, max: 1.17999267578125 },
  // Upstream capped this at 1000; sfall documents "the maximum is 150".
  WorldMapDelay2: { min: 0, max: 150 },
  CorpseDeleteTime: { min: 0, max: 13 },
  UseWalkDistance: { min: 0, max: 3 },
  /*
    Both bounds and one description came across wrong: the upstream definition capped the starting page at 1000
    where sfall documents 0..99, and carried "Set to 0 to disable" on the page rather than on the count it
    belongs to. Taken from sfall's own ddraw.ini instead.
  */
  AutoQuickSave: { min: 0, max: 10, sentinels: { 0: "Disabled" } },
  AutoQuickSavePage: { min: -1, max: 99, sentinels: { "-1": "Current page" } },
};

// The frames are back, so a label only has to stand on its own inside its own frame: the frame states the noun
// and the tab states the component, and repeating either turns a group into the same word five times over.
const LABEL = {
  "f2_res.ini|MAIN|GRAPHICS_MODE": "Mode",
  "ddraw.ini|Graphics|Mode": "Mode",
  "f2_res.ini|IFACE|ALTERNATE_AMMO_METRE": "Mode",
  "f2_res.ini|IFACE|ALTERNATE_AMMO_LIGHT": "Main colour",
  "f2_res.ini|IFACE|ALTERNATE_AMMO_DARK": "Dark colour",
  "f2_res.ini|IFACE|IFACE_BAR_SIDE_ART": "Side art",
  "f2_res.ini|IFACE|IFACE_BAR_SIDES_ORI": "Orientation",
  "f2_res.ini|IFACE|IFACE_BAR_WIDTH": "Width",
  "f2_res.ini|MAINMENU|USE_HIRES_IMAGES": "Hi-res main menu images",
  "f2_res.ini|MAIN|SCR_WIDTH": "Width",
  "f2_res.ini|MAIN|SCR_HEIGHT": "Height",
  "ddraw.ini|Graphics|GraphicsWidth": "Width",
  "ddraw.ini|Graphics|GraphicsHeight": "Height",
  "ddraw.ini|Speed|Enable": "Enabled",
  "f2_res.ini|MAPS|FOG_LIGHT_LEVEL": "Light level",
  "fallout2.cfg|preferences|game_difficulty": "Difficulty",
  "fallout2.cfg|preferences|combat_difficulty": "Difficulty",
  "fallout2.cfg|preferences|combat_looks": "Looks",
  "fallout2.cfg|preferences|combat_messages": "Messages",
  "fallout2.cfg|preferences|combat_taunts": "Taunts",
  "fallout2.cfg|sound|debug": "Logging",
  "f2_res.ini|MAPS|FOG_OF_WAR": "Enabled",
  "ddraw.ini|Debugging|DebugMode": "Mode",
  "ddraw.ini|Misc|DamageFormula": "Damage formula",
  "ddraw.ini|Misc|SaveInCombatFix": "Saving",
  "ddraw.ini|Misc|ReloadReserve": "Reload behaviour",
  "ddraw.ini|Misc|FullItemDescInBarter": "Full item description",
  "ddraw.ini|Misc|AutoQuickSave": "Quick save pages",
  "ddraw.ini|Misc|AutoQuickSavePage": "First quick save page",
  "fallout2.cfg|sound|master_volume": "Master",
  "fallout2.cfg|sound|music_volume": "Music",
  "fallout2.cfg|sound|sndfx_volume": "Sound effects",
  "fallout2.cfg|sound|speech_volume": "Speech",
  "fallout2.cfg|sound|music": "Music enabled",
  "fallout2.cfg|sound|sounds": "Sound effects enabled",
  "fallout2.cfg|sound|speech": "Speech enabled",
  "fallout2.cfg|preferences|combat_speed": "Combat speed",
  "ddraw.ini|Graphics|FadeMultiplier": "Fade speed",
  "f2_res.ini|OTHER_SETTINGS|FADE_TIME_MODIFIER": "Fade time",
};

// Terse rewrites of the upstream descriptions, which were written as ini comments and read like them: they
// restate the label, spell out value meanings the control already renders as named sentinels, and re-state
// dependencies now carried by the gate and conflict notes. `null` drops the help entirely.
const HELP = {
  "fallout2.cfg|sound|cache_size": "Sound effect cache. The engine refuses anything from 262144 up.",
  "fallout2.cfg|system|free_space": "Read and written back, but fallout2-ce never uses it.",
  "fallout2.cfg|system|interrupt_walk": "A new command interrupts walking.",
  "ddraw.ini|Input|ReloadWeaponKey": "Reloads the equipped weapon, or uses the active item.",
  "ddraw.ini|Input|ItemFastMoveKey": "Held down, moves a whole stack at once and skips the Move Items window.",
  "ddraw.ini|Input|FastMoveFromContainer": "Applies while looting without the key held.",
  "ddraw.ini|Graphics|GraphicsWidth": null,
  "ddraw.ini|Graphics|GraphicsHeight": null,
  "ddraw.ini|Graphics|AllowDShowMovies": "Plays AVI files in place of the original movies.",
  "ddraw.ini|Graphics|FadeMultiplier": "Below 100 is faster, above is slower.",
  "ddraw.ini|Interface|ActionPointsBar": "Needs high-resolution patch 4.1.8 or newer.",
  "ddraw.ini|Interface|ExpandWorldMap":
    "Needs high-resolution patch 4.1.8, a resolution of at least 890x720, and the WORLDMAP.frm from sfall.dat.",
  "ddraw.ini|Interface|WorldMapTerrainInfo": "Shown when hovering the player's marker.",
  "ddraw.ini|Misc|SaveInCombatFix": "Saving in combat stays risky even with this on.",
  "ddraw.ini|Misc|AutoQuickSave": "Quick saves cycle through this many pages of slots.",
  "ddraw.ini|Misc|AutoQuickSavePage": "Where that cycle starts.",
  "ddraw.ini|Misc|NPCAutoLevel": "Party members level up as soon as they qualify.",
  "ddraw.ini|Misc|CorpseDeleteTime": "Counted from when you leave the map.",
  "ddraw.ini|Misc|SuperStimExploitFix": "Blocks using super stims on a critter already at full health.",
  "ddraw.ini|Misc|DontTurnOffSneakIfYouRun": "Stops the player running while sneaking without the Silent Running perk.",
  "ddraw.ini|Misc|UseWalkDistance": "Within this distance the player walks to an object rather than runs.",
  "ddraw.ini|Misc|StackEmptyWeapons": "Regardless of what ammo was loaded before.",
  "ddraw.ini|Misc|ReloadReserve": "Ammo boxes held back when you drag ammo onto a weapon; 0 uses them all.",
  "ddraw.ini|Misc|WorldMapTimeMod": "Game time only - the encounter rate is unaffected. 0 stops the clock.",
  "ddraw.ini|Misc|WorldMapEncounterRate": "Higher is rarer.",
  "ddraw.ini|Misc|WorldMapFPSPatch": "Uses Fallout 1's world map speed code.",
  "ddraw.ini|Misc|WorldMapDelay2": "Higher is slower. Default is 66.",
  "ddraw.ini|Misc|DisplaySwiftLearnerExp": "Includes the perk's bonus in unscripted experience gains.",
  "ddraw.ini|Misc|DisplayKarmaChanges": null,
  "ddraw.ini|Misc|PartyMemberExtraInfo": "Level, AC and addiction, on the combat panel.",
  "ddraw.ini|Misc|ItemCounterDefaultMax": "Not in the barter screen.",
  "ddraw.ini|Misc|FullItemDescInBarter": "Weapons and ammo only.",
  "ddraw.ini|Misc|UseFileSystemOverride": "Required by some mods; leave it alone otherwise.",
  "ddraw.ini|Misc|ProcessorIdle":
    "Milliseconds to idle per input loop; 0 idles only when another process needs the CPU.",
  "ddraw.ini|Misc|SkipLoadingGameSettings":
    "Fallout 2 keeps some preferences in savegames; this reads them from fallout2.cfg instead.",
  "f2_res.ini|INPUT|SCROLLWHEEL_FOCUS_PRIMARY_MENU": "Unless the cursor is over another list.",
  "f2_res.ini|INPUT|ALT_MOUSE_INPUT":
    "The hi-res patch's own handling; turn it off to let sfall's mouse functions work.",
  "f2_res.ini|INPUT|EXTRA_WIN_MSG_CHECKS": "Extra Windows message checks, mostly needed in windowed mode.",
  "f2_res.ini|MAIN|REFRESH_RATE": null,
  "f2_res.ini|MAINMENU|MENU_BG_OFFSET_X": "From the top button to the background's edge.",
  "f2_res.ini|MAINMENU|MENU_BG_OFFSET_Y": "From the top button to the background's edge.",
  "f2_res.ini|MAPS|NumPathNodes": "1 is the original range.",
  "f2_res.ini|OTHER_SETTINGS|FADE_TIME_MODIFIER": "60 is the original; lower is quicker, higher is slower.",
  "f2_res.ini|IFACE|ALTERNATE_AMMO_METRE": "Single colour mode uses the two palette offsets below.",
  "f2_res.ini|OTHER_SETTINGS|FADE_TIME_RECALCULATE_ON_FADE": "For fades whose length seems to vary between restarts.",
  "f2_res.ini|OTHER_SETTINGS|CPU_USAGE_FIX": null,

  // Imported from sfall's own ddraw.ini v4.5 and the hi-res patch's f2_res.ini, tidied to one sentence. Entries
  // whose upstream text just enumerates the option values are left out: the control already renders those.
  "ddraw.ini|Debugging|Init": "Prints messages during sfall initialization.",
  "ddraw.ini|Debugging|Hook": "Prints messages relating to hook scripts.",
  "ddraw.ini|Debugging|Script": "Prints messages relating to scripting.",
  "ddraw.ini|Debugging|Criticals": "Prints messages relating to the critical table.",
  "ddraw.ini|Debugging|Fixes": "Prints messages relating to engine fixes.",
  "ddraw.ini|Speed|SpeedMultiInitial": "The initial speed at game startup.",
  "ddraw.ini|Misc|InventoryApCost": "Also changes the related effect of the Quick Pockets perk.",
  "ddraw.ini|Misc|SingleCore": "Forces Fallout not to use multiple cores even where they are available.",
  "ddraw.ini|Misc|PlayIdleAnimOnReload": "Forces the player to play the idle animation when reloading.",
  "ddraw.ini|Input|ReverseMouseButtons": "Swaps the left and right mouse buttons.",
  "ddraw.ini|Misc|CombatPanelAnimDelay": "Lower is faster.",
  "ddraw.ini|Misc|DialogPanelAnimDelay": "Lower is faster.",
  "ddraw.ini|Misc|PipboyTimeAnimDelay": "Lower is faster.",
  "ddraw.ini|Misc|DisplayBonusDamage": "Shown in the inventory.",
  "f2_res.ini|MAIN|f2_res_dat": "Loaded after master.dat.",
  "f2_res.ini|MAINMENU|USE_HIRES_IMAGES": "Uses hi-res menu graphics instead of the original mainmenu.frm.",
  "f2_res.ini|MAINMENU|SCALE_BUTTONS_AND_TEXT_MENU": "Scales the buttons and text up to match hi-res graphics.",
};

// Gating rules recovered from the previous UI's enable_if/disable_if calls. A setting whose controller is not in
// the required state has no effect, so showing it as freely editable invites a change that silently does nothing.
// Keyed by the gated setting; the value names the controlling setting and the values that make it live.
const GATED_BY = {
  "ddraw.ini|Speed|SpeedMultiInitial": ["ddraw.ini|Speed|Enable", { is: ["1"] }],
  "ddraw.ini|Graphics|GraphicsWidth": ["ddraw.ini|Graphics|Mode", { is: ["4", "5", "6"] }],
  "ddraw.ini|Graphics|GraphicsHeight": ["ddraw.ini|Graphics|Mode", { is: ["4", "5", "6"] }],
  // Not from a handler - the previous UI never gated this one, and the dependency survived only as the prose
  // "Requires DX9 graphics mode" in its description. Same controller and values as the two above.
  "ddraw.ini|Graphics|AllowDShowMovies": ["ddraw.ini|Graphics|Mode", { is: ["4", "5", "6"] }],
  // Also prose-only. The controller binds a key, so the live states are every one but unbound.
  "ddraw.ini|Input|FastMoveFromContainer": ["ddraw.ini|Input|ItemFastMoveKey", { isNot: ["0"] }],
  "ddraw.ini|Misc|WorldMapDelay2": ["ddraw.ini|Misc|WorldMapFPSPatch", { is: ["1"] }],
  "ddraw.ini|Misc|WorldMapEncounterRate": ["ddraw.ini|Misc|WorldMapEncounterFix", { is: ["1"] }],
  "f2_res.ini|INPUT|EXTRA_WIN_MSG_CHECKS": ["f2_res.ini|INPUT|ALT_MOUSE_INPUT", { is: ["0"] }],
  "f2_res.ini|IFACE|ALTERNATE_AMMO_LIGHT": ["f2_res.ini|IFACE|ALTERNATE_AMMO_METRE", { is: ["1"] }],
  "f2_res.ini|IFACE|ALTERNATE_AMMO_DARK": ["f2_res.ini|IFACE|ALTERNATE_AMMO_METRE", { is: ["1"] }],
  "f2_res.ini|MAPS|FOG_LIGHT_LEVEL": ["f2_res.ini|MAPS|FOG_OF_WAR", { is: ["1"] }],
  "f2_res.ini|MAINMENU|MENU_BG_OFFSET_X": ["f2_res.ini|MAINMENU|USE_HIRES_IMAGES", { is: ["1"] }],
  "f2_res.ini|MAINMENU|MENU_BG_OFFSET_Y": ["f2_res.ini|MAINMENU|USE_HIRES_IMAGES", { is: ["1"] }],
  "f2_res.ini|MAINMENU|SCALE_BUTTONS_AND_TEXT_MENU": ["f2_res.ini|MAINMENU|USE_HIRES_IMAGES", { is: ["1"] }],
  // Fullscreen-only and windowed-only options, from the previous UI's enable/disable_element block.
  "f2_res.ini|MAIN|COLOUR_BITS": ["f2_res.ini|MAIN|WINDOWED", { is: ["0"] }],
  "f2_res.ini|MAIN|REFRESH_RATE": ["f2_res.ini|MAIN|WINDOWED", { is: ["0"] }],
  "f2_res.ini|MAIN|WINDOWED_FULLSCREEN": ["f2_res.ini|MAIN|WINDOWED", { is: ["1"] }],
  "f2_res.ini|MAPS|SCROLL_DIST_X": ["f2_res.ini|MAPS|IGNORE_PLAYER_SCROLL_LIMITS", { is: ["0"] }],
  "f2_res.ini|MAPS|SCROLL_DIST_Y": ["f2_res.ini|MAPS|IGNORE_PLAYER_SCROLL_LIMITS", { is: ["0"] }],
};

// Pairings the engine handles badly. Unlike a gate neither setting is disabled - each works on its own, and it
// is the combination that misbehaves - so the interface warns while both are in the states named.
const CONFLICTS = {
  "f2_res.ini|OTHER_SETTINGS|CPU_USAGE_FIX": {
    id: "ddraw.ini|Misc|ProcessorIdle",
    self: { is: ["1"] },
    // ProcessorIdle counts milliseconds, with -1 for off, so every other value is idling of some length.
    other: { isNot: ["-1"] },
    note: "both idle the process and the two together cause slowdowns",
  },
};

// Values ZAX pins. The previous implementation forced UAC_AWARE off on every load; leaving it on makes the
// high-resolution patch search for its ini elsewhere, so a user who turns it on gets confusing results.
const MANAGED = {
  "f2_res.ini|MAIN|UAC_AWARE": { value: "0", reason: "ZAX keeps this off so the patch finds its own config" },
};

const PATHS = new Set([
  "music_path1",
  "music_path2",
  "critter_dat",
  "critter_patches",
  "master_dat",
  "master_patches",
  "executable",
  "f2_res_dat",
  "f2_res_patches",
]);

function kindFor(item, key) {
  if (SCALE_MAX[key]) return { type: "scale", max: SCALE_MAX[key] };
  if (item && item.options) {
    return {
      type: "choice",
      options: item.options.map((o) => ({
        value: String(o.value),
        label: String(o.name ?? o.value),
        ...(o.desc ? { help: String(o.desc) } : {}),
      })),
    };
  }
  const t = item && item.type;
  if (t === "dx_key") return { type: "key" };
  if (t === "string") return PATHS.has(key) ? { type: "text", path: true } : { type: "text" };
  if (t === "float") {
    // The upstream `float_base` was a slider-resolution trick for a toolkit whose sliders were integer-only -
    // it multiplied the range up, and said nothing about how the value is stored. The files hold plain decimals.
    return { type: "float", ...num(item, key), ...unit(key) };
  }
  if (t === "int") return { type: "int", ...num(item, key), ...unit(key) };
  return { type: "bool", onValue: "1", offValue: "0" };
}

const unit = (key) => (UNIT[key] ? { unit: UNIT[key] } : {});

/*
  Ceilings we can account for, and only those. Every other upper bound in the source is dropped: several are
  annotated "# arbitrary" or "# just a random value, have to put something here", and the rest are asserted
  nowhere - a ceiling we cannot source rejects values the engine accepts.

  Floors are unaffected. A resolution below 640 is a real defect, and a delay, a cost or a rate has no negative
  values; we know where these quantities start even where we do not know where they stop.
*/
const KNOWN_MAX = {
  // Stated by the config file's own comment, quoted.
  NumPathNodes: "Multiples of 2000 nodes, 1=2000(original) ... 20=40000(max)",
  FOG_LIGHT_LEVEL: "Set FOG_LIGHT_LEVEL between 0-10 ... 0 = Off, 1 = darkest, 10 = brightest",

  // sfall's ddraw.ini states each of these outright.
  CombatPanelAnimDelay: "valid range: 0..65535",
  DialogPanelAnimDelay: "valid range: 0..255",
  PipboyTimeAnimDelay: "valid range: 0..127",
  UseWalkDistance: "valid range: 0..3",
  CorpseDeleteTime: "the timer (in days) ... valid range: 0..13",
  WorldMapDelay2: "Default is 66 milliseconds, and the maximum is 150",

  // sfall's own ddraw.ini documents both: "AutoQuickSave sets the number of pages used for quick saving (valid
  // range: 1..10)" and "AutoQuickSavePage sets the starting page number for quick saving (valid range: 0..99)".
  AutoQuickSave: "documented 1..10, 0 disables",
  AutoQuickSavePage: "documented 0..99, -1 means the current page",

  // fallout2-ce's own code: it rejects a sound cache >= 0x40000 outright, and wraps the splash index at
  // SPLASH_COUNT, which is 10.
  cache_size: "the engine refuses >= 0x40000",
  splash: "SPLASH_COUNT is 10, and the index wraps to 0",

  // Chosen by this project rather than found in a source: nothing documents an upper limit, but a value past
  // these is a typo rather than an intention, and the box is easier to use with an end to it.
  REFRESH_RATE: "capped at 300Hz by choice",
  SCR_WIDTH: "capped at 4K by choice",
  SCR_HEIGHT: "capped at 4K by choice",
  GraphicsWidth: "capped at 4K by choice",
  GraphicsHeight: "capped at 4K by choice",

  // fallout2-ce's preference table carries a min and max per slider, and clamps to them on load:
  // combat_speed 0..50, text_base_delay 1..6, brightness 1..1.17999267578125, mouse_sensitivity 1..2.5.
  // text_line_delay is not in that table - the engine derives it as (text_base_delay - 1) * 0.4, so 1..6
  // yields 0..2 - which is why the previous interface hid its control.
  brightness: "engine preference table",
  mouse_sensitivity: "engine preference table",
  text_base_delay: "engine preference table",
  text_line_delay: "derived from text_base_delay",
  combat_speed: "engine preference table",
};

const num = (item, key) => {
  const override = NUMERIC[key] ?? {};
  return {
    ...(item.min !== undefined ? { min: item.min } : {}),
    ...(item.max !== undefined && key in KNOWN_MAX ? { max: item.max } : {}),
    ...override,
  };
};

/** Labels carried their unit inline ("Game speed, %"); the unit field now owns it. */
const stripUnit = (label) =>
  label
    .replace(/,\s*(%|ms|days|px|s)\s*$/i, "")
    .replace(/\s*\((delay)\)\s*/i, " ")
    .trim();

/** Some help strings are multi-line lists that would render as a run-on paragraph. */
const tidyHelp = (text) =>
  String(text)
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

function helpFor(k, item) {
  if (k in HELP) return HELP[k] === null ? {} : { help: HELP[k] };
  return item && item.desc ? { help: tidyHelp(item.desc) } : {};
}

const titleCase = (key) =>
  key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());

const layout = JSON.parse(fs.readFileSync("scripts/gen/layout.json", "utf8"));
const orderOf = new Map(layout.map((r, i) => [`${r.file}|${r.section}|${r.key}`, i]));

const defs = [];
for (const file of FILES) {
  const doc = YAML.parse(fs.readFileSync(`scripts/gen/formats/${file}.yml`, "utf8"));
  for (const section of Object.keys(doc)) {
    if (section === "zax" || doc[section] == null) continue;
    for (const key of Object.keys(doc[section])) {
      const item = doc[section][key];
      defs.push({
        id: idFor(file, section, key),
        file,
        section,
        key,
        kind: kindFor(item, key),
        label: LABEL[`${file}|${section}|${key}`] ?? stripUnit((item && item.name) || titleCase(key)),
        ...helpFor(`${file}|${section}|${key}`, item),
        ...(MANAGED[`${file}|${section}|${key}`] ? { managed: MANAGED[`${file}|${section}|${key}`] } : {}),
        ...(GATED_BY[`${file}|${section}|${key}`]
          ? {
              gatedBy: {
                id: idFor(...GATED_BY[`${file}|${section}|${key}`][0].split("|")),
                ...GATED_BY[`${file}|${section}|${key}`][1],
              },
            }
          : {}),
        ...(CONFLICTS[`${file}|${section}|${key}`]
          ? {
              conflictsWith: {
                ...CONFLICTS[`${file}|${section}|${key}`],
                id: idFor(...CONFLICTS[`${file}|${section}|${key}`].id.split("|")),
              },
            }
          : {}),
      });
    }
  }
}

// A key in one of the hand-maintained tables that matches no setting sits inert and changes nothing, which is
// invisible in the output - an upstream rename would silently drop a gate rather than break the build.
const known = new Set(defs.map((d) => `${d.file}|${d.section}|${d.key}`));
const check = (table, k, what) => {
  if (!known.has(k)) throw new Error(`${table}: ${what} matches no setting: ${k}`);
};
for (const k of Object.keys(HELP)) check("HELP", k, "key");
for (const k of Object.keys(LABEL)) check("LABEL", k, "key");
for (const [k, [controller]] of Object.entries(GATED_BY)) {
  check("GATED_BY", k, "key");
  check("GATED_BY", controller, `controller for ${k}`);
}
for (const [k, clash] of Object.entries(CONFLICTS)) {
  check("CONFLICTS", k, "key");
  check("CONFLICTS", clash.id, `counterpart for ${k}`);
}

// Emitted in the order the previous interface laid them out, so the file diffs readably against that layout.
// Nothing reads this order: where a setting appears is the layout's business.
defs.sort((a, b) => orderOf.get(`${a.file}|${a.section}|${a.key}`) - orderOf.get(`${b.file}|${b.section}|${b.key}`));

// One setting per line: the file is read by diffing it against the previous generation, and a pretty-printed
// object per setting would make a one-field change a twenty-line diff.
const body = defs
  .map(
    (d) =>
      "  " +
      JSON.stringify(d)
        .replace(/"([A-Za-z_][A-Za-z0-9_]*)":/g, "$1: ")
        .replace(/,(?=[a-z])/g, ","),
  )
  .join(",\n");

fs.writeFileSync(
  "packages/games-fallout2/src/catalog.ts",
  `// Generated from the previous implementation's format definitions by scripts/gen/gen-catalog.mjs. Do not edit by hand;\n` +
    `// change the generator's tables and regenerate.\n\n` +
    `import type { SettingDef } from "@zax/core";\n\n` +
    `export const SETTINGS: readonly SettingDef[] = [\n${body},\n];\n`,
);

const counts = {};
for (const d of defs) counts[d.file] = (counts[d.file] ?? 0) + 1;
console.log("total:", defs.length);
console.log(counts);
console.log("with help:", defs.filter((d) => d.help).length);
const kinds = {};
for (const d of defs) kinds[d.kind.type] = (kinds[d.kind.type] ?? 0) + 1;
console.log(kinds);
