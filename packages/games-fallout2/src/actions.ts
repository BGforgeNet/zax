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
      "sfall.debugging.debugmode": "2",
      "sfall.debugging.init": "1",
      "sfall.debugging.hook": "1",
      "sfall.debugging.script": "1",
      "sfall.debugging.criticals": "1",
      "sfall.debugging.fixes": "1",
      "game.debug.output-map-data-info": "1",
      "game.debug.show-load-info": "1",
      "game.debug.show-script-messages": "1",
      "game.debug.show-tile-num": "1",
      "game.sound.debug": "1",
      "game.sound.debug-sfxc": "1",
    },
  },
  {
    id: "debug.disable",
    group: "report",
    label: "Turn debugging off",
    description: "Restores quiet operation. Logging costs performance, so leave it off for normal play.",
    appliedLabel: "Debugging is off",
    targets: {
      "sfall.debugging.debugmode": "0",
      "sfall.debugging.init": "0",
      "sfall.debugging.hook": "0",
      "sfall.debugging.script": "0",
      "sfall.debugging.criticals": "0",
      "sfall.debugging.fixes": "0",
      "game.debug.output-map-data-info": "0",
      "game.debug.show-load-info": "0",
      "game.debug.show-script-messages": "0",
      "game.debug.show-tile-num": "0",
      "game.sound.debug": "0",
      "game.sound.debug-sfxc": "0",
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
      "hires.input.extra-win-msg-checks": "1",
      "hires.other-settings.cpu-usage-fix": "1",
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
      "game.preferences.combat-speed": "50",
      "game.preferences.text-base-delay": "1.000000",
      "game.preferences.text-line-delay": "0.000000",
      "sfall.misc.combatpanelanimdelay": "0",
      "sfall.misc.dialogpanelanimdelay": "0",
      "sfall.misc.pipboytimeanimdelay": "0",
      "sfall.misc.speedinterfacecounteranims": "2",
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
