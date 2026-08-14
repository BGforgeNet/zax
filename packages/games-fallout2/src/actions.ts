import type { Action } from "@zax/core";

/**
 * What a user actually comes to ZAX to do. Each action writes several settings at once, across more than one
 * config file, so that an intention is one click rather than a hunt through categories.
 *
 * Target values are the raw strings the config files hold, taken from the same catalog the settings view uses.
 *
 * An action must write more than one setting. A single-key action is just a second path to a control the
 * settings list already offers, and it hides whichever other values that control accepts.
 */
export const ACTIONS: readonly Action[] = [
  {
    id: "debug.enable",
    group: "report",
    label: "Enable full debugging",
    description:
      "Turns on every engine and script log and writes them to debug.log. Do this before reproducing a bug you want to report.",
    appliedLabel: "Debugging is on",
    targets: {
      "sfall.Debugging.DebugMode": "2",
      "sfall.Debugging.Init": "1",
      "sfall.Debugging.Hook": "1",
      "sfall.Debugging.Script": "1",
      "sfall.Debugging.Criticals": "1",
      "sfall.Debugging.Fixes": "1",
      "game.debug.output_map_data_info": "1",
      "game.debug.show_load_info": "1",
      "game.debug.show_script_messages": "1",
      "game.debug.show_tile_num": "1",
      "game.sound.debug": "1",
      "game.sound.debug_sfxc": "1",
    },
  },
  {
    id: "debug.disable",
    group: "report",
    label: "Turn debugging off",
    description: "Restores quiet operation. Logging costs performance, so leave it off for normal play.",
    appliedLabel: "Debugging is off",
    targets: {
      "sfall.Debugging.DebugMode": "0",
      "sfall.Debugging.Init": "0",
      "sfall.Debugging.Hook": "0",
      "sfall.Debugging.Script": "0",
      "sfall.Debugging.Criticals": "0",
      "sfall.Debugging.Fixes": "0",
      "game.debug.output_map_data_info": "0",
      "game.debug.show_load_info": "0",
      "game.debug.show_script_messages": "0",
      "game.debug.show_tile_num": "0",
      "game.sound.debug": "0",
      "game.sound.debug_sfxc": "0",
    },
  },
  {
    id: "fix.not-responding",
    group: "fix",
    label: 'Fix "NOT RESPONDING" freezes',
    description:
      "Applies the two compatibility fixes for the window going unresponsive, most often seen in windowed mode on modern Windows.",
    appliedLabel: "Fix applied",
    targets: {
      "hires.INPUT.EXTRA_WIN_MSG_CHECKS": "1",
      "hires.OTHER_SETTINGS.CPU_USAGE_FIX": "1",
    },
  },
  {
    id: "speed.up",
    group: "fix",
    label: "Speed up combat and interface",
    description:
      "Removes the deliberate pauses in combat, panel animations and floating text. The single biggest quality-of-life change for a replay.",
    appliedLabel: "Already sped up",
    targets: {
      "game.preferences.combat_speed": "50",
      "game.preferences.text_base_delay": "1.000000",
      "game.preferences.text_line_delay": "0.000000",
      "sfall.Misc.CombatPanelAnimDelay": "0",
      "sfall.Misc.DialogPanelAnimDelay": "0",
      "sfall.Misc.PipboyTimeAnimDelay": "0",
      "sfall.Misc.SpeedInterfaceCounterAnims": "2",
    },
  },
];

/**
 * Presets offered as a shortcut for the high-resolution patch's width/height pair. The engine accepts any size
 * in range, so these never constrain the input.
 */
export const COMMON_RESOLUTIONS: ReadonlyArray<{ width: number; height: number; note?: string }> = [
  { width: 3840, height: 2160, note: "4K" },
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080, note: "1080p" },
  { width: 1600, height: 900 },
  { width: 1366, height: 768 },
  { width: 1280, height: 1024 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 800, height: 600 },
  { width: 640, height: 480, note: "original" },
];
