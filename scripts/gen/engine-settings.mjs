/**
 * What to call each setting an alternative engine has that no other component does, and what to say about it.
 *
 * The engine's own source supplies the section, the key, the storage kind and, where the engine clamps on
 * load, the bounds - all of it read by `extract-engines.mjs` and committed under `engines/`. This file is the
 * other half: the name a person reads, the option labels an enumeration needs, and a help line where the
 * project's own words carry a fact the control cannot draw. Nothing here is invented; a key whose project
 * says nothing about it gets no help, and the interface already degrades where help is absent.
 *
 * Every engine-only key needs an entry. `null` says it is deliberately not offered, with the reason beside
 * it, and a key in neither state fails generation - a silent omission would read exactly like a key nobody
 * had noticed yet.
 */

/*
  fallout2-ce. Bounds come from its `SETTING_P(key, clamp(a, b))` registrations, except the two whose clamp
  is stated as enum members: `screen.windowed` over WindowMode and `gameplay.perk_carryover` over
  PerkCarryOverMode, both resolved here against the enum that declares them.
*/
export const COMMUNITY_EDITION = {
  "system.screenshots_format": { label: "Screenshot format" },

  "screen.windowed": {
    label: "Window mode",
    options: [
      { value: "0", label: "Fullscreen" },
      { value: "1", label: "Windowed" },
      { value: "2", label: "Borderless" },
    ],
  },
  "screen.mouse_lock": {
    label: "Lock the mouse to the window",
    help: "Windowed and borderless only; fullscreen always locks it.",
  },
  "screen.scale": {
    label: "Pixel scale",
    help: "Renders at the resolution divided by this, then scales up. For a high-DPI display in a window.",
  },

  "ui.main_menu_scale_mode": {
    label: "Main menu",
    options: [
      { value: "0", label: "Native size" },
      { value: "1", label: "Scale the background" },
      { value: "2", label: "Scale the background and the buttons" },
    ],
  },
  "ui.in_game_menu_help": { label: "Help in the in-game menu", help: "Opens the F1 help screen." },
  "ui.perks_progress_bar": { label: "Perk progress bar" },
  "ui.alternate_ammo_meter": {
    label: "Ammo meter",
    options: [
      { value: "0", label: "Original" },
      { value: "1", label: "Burst segments" },
      { value: "2", label: "Segments for single shots too", help: "Up to six shots." },
    ],
  },
  "ui.movie_aspect_fit": { label: "Fit movies to the screen", help: "Off keeps them native size, centred." },
  "ui.edg_support": {
    label: "Load EDG files",
    help: "The hi-res patch's format for edge clipping and scroll blocking; a map's own file overrides both.",
  },
  "ui.quick_toolbar_visible": { label: "Quick toolbar" },
  "ui.anim_speed": {
    label: "Interface animation speed",
    help: "Every interface animation at once: screen fades, dialog windows, the AC counter.",
  },
  "ui.dialog_border": {
    label: "Hi-res dialog border",
    help: "Above 640x480 only, and needs HR_ALLTLK.FRM in art\\intrface\\ - f2_res.dat has one.",
  },
  "ui.enable_high_resolution_stencil": {
    label: "Hide beyond the map edges",
    help: "Above 640x480 only.",
  },
  "ui.inventory_columns": {
    label: "Inventory columns",
    help: "Two columns in the loot window need a screen at least 673px wide, and turn on party equipment there.",
  },
  "ui.loot_weight_indicator": {
    label: "Weight indicator",
    options: [
      { value: "0", label: "None" },
      { value: "1", label: "Simple" },
      { value: "2", label: "Detailed", help: "Needs more than one inventory column." },
      { value: "3", label: "Container size, without the label" },
    ],
  },
  "ui.loot_container_size_indicator_threshold": {
    label: "Show container fullness from",
    unit: "%",
    sentinels: { 0: "Always" },
  },

  "gameplay.perk_carryover": {
    label: "Unspent perks",
    options: [
      { value: "0", label: "Lost on level up", help: "The original behaviour." },
      { value: "1", label: "Kept, spent at the level they were earned" },
      { value: "2", label: "Kept, spendable now", help: "What sfall does." },
    ],
  },

  "preferences.running_burning_guy": { label: "The burning man runs" },
  "sound.gapless_music": {
    label: "Gapless music",
    help: "A map change that keeps the same track does not restart it.",
  },

  "debug.show_fps": { label: "Frame counter" },
  // No unit: the engine's config says nothing about what these count, and pixels is an inference however
  // obvious. The clamp it registers - 200..1920 and 100..1080 - is what the control draws its range from.
  "debug.window_width": { label: "Debug window width" },
  "debug.window_height": { label: "Debug window height" },
  "debug.console_output_path": { label: "Console log", path: true, help: "Where a copy of the console goes." },

  "qol.use_walk_distance": {
    label: "Walk within",
    unit: "tiles",
    sentinels: { 0: "Never walk" },
    help: "Empty tiles between the player and what they are using. The engine's own default is 3.",
  },
  "qol.auto_open_doors": { label: "Open unlocked doors automatically", help: "Only doors with no script." },
  "qol.party_trade_from_menu": { label: "Party inventory from the context menu" },
  "qol.party_loot_and_barter": { label: "Switch to a companion in the loot screen" },
};

/*
  Fallout Fission. It has no equivalent of fallout2-ce's clamp registrations - `settingsFromConfig` is plain
  reads, and the real bounds live in the consumers - so the five entries that need a range carry it here, each
  with where it was read from. It ships no example config either, so there is no upstream prose to draw help
  from: a help line below is one its source states outright, and most keys have none.
*/
export const FISSION = {
  "system.fission_dat": { label: "Fission dat" },
  "system.fission_patches": { label: "Fission patches" },
  "system.master_override": { label: "Master override" },

  "debug.write_offsets": { label: "Write offsets" },

  // `applyPlayAreaResolution` computes both from `play_area` and the display, and recomputes them whenever
  // the preferences screen is opened - so a value written here survives only until the user next looks.
  "graphics.game_width": null, // derived from play_area
  "graphics.game_height": null, // derived from play_area

  "graphics.fullscreen": { label: "Fullscreen" },
  "graphics.stretch_enabled": { label: "Stretch to the screen" },
  "graphics.preserve_aspect": { label: "Keep the aspect ratio" },
  "graphics.high_quality": { label: "High quality scaling" },
  "graphics.highres_stencil": { label: "Hide beyond the map edges" },
  "graphics.widescreen": { label: "Widescreen" },
  "graphics.square_pixels": { label: "Square pixels" },
  "graphics.play_area": {
    label: "Play area",
    // `applyPlayAreaResolution`'s own four cases, in its order.
    options: [
      { value: "0", label: "Original", help: "640x480." },
      { value: "1", label: "Default", help: "800x500." },
      { value: "2", label: "Large", help: "70% of the display." },
      { value: "3", label: "Massive", help: "The whole display." },
    ],
  },
  "graphics.widescreen_variant_suffix": { label: "Widescreen art suffix" },

  "enhancements.StrictVanilla": {
    label: "Strict vanilla",
    help: "Turns off every other enhancement, whatever each of them is set to.",
  },
  // Slots rather than pages, unlike sfall's and fallout2-ce's key of the same name. Its ceiling is the
  // install's own effective save-slot count, which is a runtime value, so only the floor is stated.
  "enhancements.AutoQuickSave": { label: "Quick save slots", min: 0, sentinels: { 0: "Disabled" } },
  "enhancements.AutoOpenDoors": { label: "Open unlocked doors automatically" },
  "enhancements.GaplessMusic": { label: "Gapless music" },
  "enhancements.MassHighlight": { label: "Highlight everything at once" },
  "enhancements.GameSpeed": { label: "Game speed control" },
  "enhancements.AutoPush": { label: "Push party members out of the way" },
  "enhancements.Minimap": { label: "Minimap" },
  // `inventoryUpdateLayout` clamps to 1..4, and refuses the fourth column without widescreen because it
  // crashes - a dependency across two sections, which no value gate expresses, so it is said in the help.
  "enhancements.InventoryColumns": {
    label: "Inventory columns",
    min: 1,
    max: 4,
    help: "A fourth column needs Widescreen on.",
  },
  "enhancements.NpcArmor": { label: "Party members wear armour" },
};

/** Which table describes which engine. */
export const ENGINE_TABLES = { "fallout2-ce": COMMUNITY_EDITION, fission: FISSION };

/**
 * Settings an engine reads under one name that another component already has under a different one, where
 * every side holds the same values. Same rule as the catalog's own bindings, and named here rather than
 * derived because the two names differ - the derivation only finds a key spelled identically on both sides.
 */
/** @type {ReadonlyArray<[string, Record<string, string>]>} */
export const ENGINE_BINDINGS = [
  ["fallout2.cfg|qol|auto_open_doors", { fission: "fission.cfg|enhancements|AutoOpenDoors" }],
  ["fallout2.cfg|sound|gapless_music", { fission: "fission.cfg|enhancements|GaplessMusic" }],
  ["fallout2.cfg|ui|enable_high_resolution_stencil", { fission: "fission.cfg|graphics|highres_stencil" }],
];

/**
 * Every enhancement Fission gates behind `StrictVanilla`, which is all sixteen of them - the switch itself is
 * the seventeenth key in the section and is not gated by itself. Read off each use site rather than assumed
 * from the section: the consumers spell it several ways (`x && !strict_vanilla`, an `if (strict_vanilla)`
 * returning early, a clamp to the vanilla value), and a list taken from the section alone would gate the
 * switch too.
 *
 * The gate rides on the Fission target, so it applies to a linked setting's Fission half without touching the
 * sfall or game half - which is the case this design keeps gates per target for.
 */
export const STRICT_VANILLA_GATES = [
  "AutoQuickSave",
  "AutoOpenDoors",
  "GaplessMusic",
  "EnhancedBarter",
  "NumbersInDialogue",
  "DisplayBonusDamage",
  "ExplosionsEmitLight",
  "RemoveCriticalTimelimits",
  "DisplayKarmaChanges",
  "SkipOpeningMovies",
  "MassHighlight",
  "GameSpeed",
  "AutoPush",
  "Minimap",
  "InventoryColumns",
  "NpcArmor",
];

/** What the gate says: the enhancements are live while the switch is off. */
export const STRICT_VANILLA = { section: "enhancements", key: "StrictVanilla" };

/**
 * What each engine's group of tabs is called, and what to call each section within it. The section names are
 * the engine's own and read as identifiers; these are what a person sees, in the order the tabs run in.
 *
 * Keyed by file and section together, because an engine's tabs span more than one file: fallout2-ce reads its
 * own `fallout2.cfg` sections and, through the settings linked to it, the content patch's `game#patch.cfg`.
 * A section with no entry here fails generation rather than appearing under its raw name.
 */
export const ENGINE_TABS = {
  "fallout2-ce": {
    label: "CE",
    sections: {
      "fallout2.cfg|screen": "Screen",
      "fallout2.cfg|ui": "Interface",
      "fallout2.cfg|qol": "Quality of life",
      "fallout2.cfg|gameplay": "Gameplay",
      "game#patch.cfg|combat": "Combat",
      "game#patch.cfg|explosions": "Explosions",
      "game#patch.cfg|worldmap": "World map",
      "fallout2.cfg|preferences": "Preferences",
      "fallout2.cfg|sound": "Sound",
      "fallout2.cfg|system": "System",
      "fallout2.cfg|debug": "Debug",
    },
  },
  fission: {
    label: "Fission",
    sections: {
      "fission.cfg|graphics": "Graphics",
      "fission.cfg|enhancements": "Enhancements",
      "fission.cfg|preferences": "Preferences",
      "fission.cfg|sound": "Sound",
      "fission.cfg|system": "System",
      "fission.cfg|debug": "Debug",
    },
  },
};
