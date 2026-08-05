// Generated from the previous implementation's layout modules by .work/gen-layout.mjs. Do not edit by hand.
//
// The tab, frame and control order the previous interface presented, so a user coming from it finds every
// setting where they left it. What each setting IS lives in the catalog; this only says where it was shown.

/** The control the previous interface drew, which its catalog kind alone does not determine. */
export type Control = "checkbox" | "slider" | "spin" | "dropdown" | "qinput" | "radio";

/** A control, a titled group of them, or one of the few widgets that is not a single setting. */
export type LayoutNode =
  | { kind: "setting"; id: string; control: Control; hidden?: boolean }
  | { kind: "frame"; title: string; items: readonly LayoutNode[] }
  | { kind: "widget"; id: string };

export interface LayoutTab {
  title: string;
  items: readonly LayoutNode[];
}

export interface LayoutFile {
  /** The config file this tab edits. */
  file: string;
  /** What the previous interface called it - the component, not the filename. */
  label: string;
  tabs: readonly LayoutTab[];
}

export const LAYOUT: readonly LayoutFile[] = [
 {
  "file": "fallout2.cfg",
  "label": "Game",
  "tabs": [
   {
    "title": "Preferences",
    "items": [
     {
      "kind": "setting",
      "id": "game.preferences.brightness",
      "control": "slider"
     },
     {
      "kind": "setting",
      "id": "game.preferences.game-difficulty",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "game.preferences.item-highlight",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.language-filter",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.mouse-sensitivity",
      "control": "slider"
     },
     {
      "kind": "setting",
      "id": "game.preferences.running",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.subtitles",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.text-base-delay",
      "control": "slider"
     },
     {
      "kind": "setting",
      "id": "game.preferences.text-line-delay",
      "control": "slider",
      "hidden": true
     },
     {
      "kind": "frame",
      "title": "Sound volume",
      "items": [
       {
        "kind": "setting",
        "id": "game.sound.master-volume",
        "control": "slider"
       },
       {
        "kind": "setting",
        "id": "game.sound.music-volume",
        "control": "slider"
       },
       {
        "kind": "setting",
        "id": "game.sound.sndfx-volume",
        "control": "slider"
       },
       {
        "kind": "setting",
        "id": "game.sound.speech-volume",
        "control": "slider"
       }
      ]
     }
    ]
   },
   {
    "title": "Combat",
    "items": [
     {
      "kind": "setting",
      "id": "game.preferences.combat-difficulty",
      "control": "radio"
     },
     {
      "kind": "frame",
      "title": "Speed",
      "items": [
       {
        "kind": "setting",
        "id": "game.preferences.combat-speed",
        "control": "slider"
       },
       {
        "kind": "setting",
        "id": "game.preferences.player-speedup",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "setting",
      "id": "game.preferences.combat-looks",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.combat-messages",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "game.preferences.combat-taunts",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.target-highlight",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "game.preferences.violence-level",
      "control": "dropdown"
     }
    ]
   },
   {
    "title": "Advanced",
    "items": [
     {
      "kind": "frame",
      "title": "System",
      "items": [
       {
        "kind": "setting",
        "id": "game.system.art-cache-size",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.system.color-cycling",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.system.critter-dat",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.critter-patches",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.cycle-speed-factor",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.system.executable",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.free-space",
        "control": "spin",
        "hidden": true
       },
       {
        "kind": "setting",
        "id": "game.system.hashing",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.system.interrupt-walk",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.system.language",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.master-dat",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.master-patches",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.scroll-lock",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.system.splash",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Sound",
      "items": [
       {
        "kind": "setting",
        "id": "game.sound.music",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.sound.sounds",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.sound.speech",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.sound.music-path1",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.sound.music-path2",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.sound.cache-size",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.sound.device",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "game.sound.dma",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.sound.initialize",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.sound.irq",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.sound.port",
        "control": "qinput"
       }
      ]
     }
    ]
   },
   {
    "title": "Debug",
    "items": [
     {
      "kind": "frame",
      "title": "Main",
      "items": [
       {
        "kind": "setting",
        "id": "game.debug.output-map-data-info",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show-load-info",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show-script-messages",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show-tile-num",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Sound",
      "items": [
       {
        "kind": "setting",
        "id": "game.sound.debug",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.sound.debug-sfxc",
        "control": "checkbox"
       }
      ]
     }
    ]
   }
  ]
 },
 {
  "file": "f2_res.ini",
  "label": "HiRes",
  "tabs": [
   {
    "title": "Main",
    "items": [
     {
      "kind": "frame",
      "title": "Graphics",
      "items": [
       {
        "kind": "setting",
        "id": "hires.main.graphics-mode",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.main.scale-2x",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.effects.is-gray-scale",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.main.windowed",
        "control": "radio"
       },
       {
        "kind": "setting",
        "id": "hires.main.windowed-fullscreen",
        "control": "checkbox"
       },
       {
        "kind": "frame",
        "title": "Fullscreen",
        "items": [
         {
          "kind": "setting",
          "id": "hires.main.colour-bits",
          "control": "dropdown"
         },
         {
          "kind": "setting",
          "id": "hires.main.refresh-rate",
          "control": "spin"
         }
        ]
       },
       {
        "kind": "frame",
        "title": "Resolution",
        "items": [
         {
          "kind": "widget",
          "id": "f2_res.ini-resolution"
         },
         {
          "kind": "setting",
          "id": "hires.main.scr-width",
          "control": "spin"
         },
         {
          "kind": "setting",
          "id": "hires.main.scr-height",
          "control": "spin"
         }
        ]
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Maps",
      "items": [
       {
        "kind": "setting",
        "id": "hires.maps.edge-clipping-on",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.maps.ignore-map-edges",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.maps.ignore-player-scroll-limits",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.maps.scroll-dist-x",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "hires.maps.scroll-dist-y",
        "control": "qinput"
       }
      ]
     },
     {
      "kind": "setting",
      "id": "hires.maps.numpathnodes",
      "control": "spin"
     },
     {
      "kind": "frame",
      "title": "Fog of war",
      "items": [
       {
        "kind": "setting",
        "id": "hires.maps.fog-of-war",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.maps.fog-light-level",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Delays",
      "items": [
       {
        "kind": "setting",
        "id": "hires.other-settings.splash-scrn-time",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "hires.other-settings.fade-time-modifier",
        "control": "spin"
       }
      ]
     }
    ]
   },
   {
    "title": "Scaling",
    "items": [
     {
      "kind": "setting",
      "id": "hires.movies.movie-size",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "hires.mainmenu.main-menu-size",
      "control": "radio"
     },
     {
      "kind": "frame",
      "title": "HiRes menu backgronud",
      "items": [
       {
        "kind": "setting",
        "id": "hires.mainmenu.use-hires-images",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.mainmenu.menu-bg-offset-x",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "hires.mainmenu.menu-bg-offset-y",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "hires.mainmenu.scale-buttons-and-text-menu",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "setting",
      "id": "hires.static-screens.death-scrn-size",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "hires.static-screens.end-slide-size",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "hires.static-screens.help-scrn-size",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "hires.static-screens.splash-scrn-size",
      "control": "radio"
     }
    ]
   },
   {
    "title": "Interface",
    "items": [
     {
      "kind": "frame",
      "title": "Interface bar",
      "items": [
       {
        "kind": "setting",
        "id": "hires.iface.iface-bar-mode",
        "control": "radio"
       },
       {
        "kind": "setting",
        "id": "hires.iface.iface-bar-side-art",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.iface.iface-bar-sides-ori",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.iface.iface-bar-width",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Dialog and barter",
      "items": [
       {
        "kind": "setting",
        "id": "hires.other-settings.dialog-scrn-background",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.other-settings.dialog-scrn-art-fix",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.other-settings.barter-pc-inv-drop-fix",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.input.scrollwheel-focus-primary-menu",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Alternate ammo metre",
      "items": [
       {
        "kind": "setting",
        "id": "hires.iface.alternate-ammo-metre",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.iface.alternate-ammo-light",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "hires.iface.alternate-ammo-dark",
        "control": "qinput"
       }
      ]
     }
    ]
   },
   {
    "title": "Advanced",
    "items": [
     {
      "kind": "setting",
      "id": "hires.other-settings.cd-check",
      "control": "checkbox"
     },
     {
      "kind": "frame",
      "title": "Troubleshooting",
      "items": [
       {
        "kind": "setting",
        "id": "hires.input.alt-mouse-input",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.input.extra-win-msg-checks",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.other-settings.cpu-usage-fix",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.other-settings.fade-time-recalculate-on-fade",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "System",
      "items": [
       {
        "kind": "setting",
        "id": "hires.main.f2-res-dat",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "hires.main.f2-res-patches",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "hires.main.uac-aware",
        "control": "checkbox",
        "hidden": true
       }
      ]
     }
    ]
   }
  ]
 },
 {
  "file": "ddraw.ini",
  "label": "Sfall",
  "tabs": [
   {
    "title": "Main",
    "items": [
     {
      "kind": "frame",
      "title": "Manage",
      "items": [
       {
        "kind": "widget",
        "id": "txt_sfall_current"
       },
       {
        "kind": "widget",
        "id": "btn_sfall_update"
       },
       {
        "kind": "widget",
        "id": "txt_sfall_latest"
       },
       {
        "kind": "widget",
        "id": "btn_sfall_check"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Speed",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.speed.enable",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.speed.speedmultiinitial",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Graphics",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.graphics.mode",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.graphics.graphicswidth",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.graphics.graphicsheight",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.graphics.gpublt",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.graphics.allowdshowmovies",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.graphics.fademultiplier",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Combat",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.misc.damageformula",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.saveincombatfix",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.fastshotfix",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.inventoryapcost",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.quickpocketsapcostreduction",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Misc",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.misc.usefilesystemoverride",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.npcautolevel",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.singlecore",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.playidleanimonreload",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.corpsedeletetime",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.processoridle",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.skipopeningmovies",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.superstimexploitfix",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.explosionsemitlight",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.dontturnoffsneakifyourun",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.usewalkdistance",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.skiploadinggamesettings",
        "control": "dropdown"
       }
      ]
     }
    ]
   },
   {
    "title": "Interface",
    "items": [
     {
      "kind": "setting",
      "id": "sfall.interface.actionpointsbar",
      "control": "checkbox"
     },
     {
      "kind": "frame",
      "title": "Input",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.input.usescrollwheel",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.input.middlemouse",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "sfall.input.reversemousebuttons",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.input.reloadweaponkey",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "sfall.input.itemfastmovekey",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "sfall.input.fastmovefromcontainer",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Animation speed",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.misc.combatpanelanimdelay",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.dialogpanelanimdelay",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.pipboytimeanimdelay",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.speedinterfacecounteranims",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.instantweaponequip",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Dialog",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.misc.numbersindialogue",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.enablemusicindialogue",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.partymemberextrainfo",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Inventory",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.misc.stackemptyweapons",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.reloadreserve",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.itemcounterdefaultmax",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.displaybonusdamage",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Barter",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.misc.fullitemdescinbarter",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Saves",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.misc.extrasaveslots",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.autoquicksave",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.autoquicksavepage",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "PDA",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.misc.displayswiftlearnerexp",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.activegeigermsgs",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.misc.displaykarmachanges",
        "control": "checkbox"
       }
      ]
     }
    ]
   },
   {
    "title": "Worldmap",
    "items": [
     {
      "kind": "setting",
      "id": "sfall.interface.expandworldmap",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "sfall.interface.worldmaptravelmarkers",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.interface.worldmapterraininfo",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.misc.worldmaptimemod",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "sfall.misc.worldmapfpspatch",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.misc.worldmapdelay2",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "sfall.misc.worldmapencounterfix",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.misc.worldmapencounterrate",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "sfall.misc.worldmapfontpatch",
      "control": "checkbox"
     }
    ]
   },
   {
    "title": "Debug",
    "items": [
     {
      "kind": "setting",
      "id": "sfall.debugging.debugmode",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "sfall.debugging.init",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.debugging.hook",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.debugging.script",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.debugging.criticals",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.debugging.fixes",
      "control": "checkbox"
     }
    ]
   }
  ]
 }
];
