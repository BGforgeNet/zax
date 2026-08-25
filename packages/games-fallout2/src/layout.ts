// Generated from the previous implementation's layout modules by scripts/gen/gen-layout.mjs. Do not edit by hand.
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
  /**
   * What identifies this group of tabs and keys which of them is open: the config file's name for the game's
   * own three, the engine's id for an engine's. An engine's tabs are not one file's - fallout2-ce shows both
   * the keys it reads from the game's config and the ones a linked setting puts in the content patch.
   */
  id: string;
  /** What the previous interface called it - the component, not the filename. */
  label: string;
  /** The engine whose settings these tabs show, absent for the game's own three. */
  engine?: string;
  tabs: readonly LayoutTab[];
}

export const LAYOUT: readonly LayoutFile[] = [
 {
  "id": "fallout2.cfg",
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
      "id": "game.preferences.game_difficulty",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "game.preferences.item_highlight",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.language_filter",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.mouse_sensitivity",
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
      "id": "game.preferences.text_base_delay",
      "control": "slider"
     },
     {
      "kind": "setting",
      "id": "game.preferences.text_line_delay",
      "control": "slider",
      "hidden": true
     },
     {
      "kind": "frame",
      "title": "Sound volume",
      "items": [
       {
        "kind": "setting",
        "id": "game.sound.master_volume",
        "control": "slider"
       },
       {
        "kind": "setting",
        "id": "game.sound.music_volume",
        "control": "slider"
       },
       {
        "kind": "setting",
        "id": "game.sound.sndfx_volume",
        "control": "slider"
       },
       {
        "kind": "setting",
        "id": "game.sound.speech_volume",
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
      "id": "game.preferences.combat_difficulty",
      "control": "radio"
     },
     {
      "kind": "frame",
      "title": "Speed",
      "items": [
       {
        "kind": "setting",
        "id": "game.preferences.combat_speed",
        "control": "slider"
       },
       {
        "kind": "setting",
        "id": "game.preferences.player_speedup",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "setting",
      "id": "game.preferences.combat_looks",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.combat_messages",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "game.preferences.combat_taunts",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.target_highlight",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "game.preferences.violence_level",
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
        "id": "game.system.art_cache_size",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.system.color_cycling",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.system.critter_dat",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.critter_patches",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.cycle_speed_factor",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.system.executable",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.free_space",
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
        "id": "game.system.interrupt_walk",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.system.language",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.master_dat",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.master_patches",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.system.scroll_lock",
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
        "id": "game.sound.music_path1",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.sound.music_path2",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "game.sound.cache_size",
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
        "id": "game.debug.mode",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "game.debug.output_map_data_info",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show_load_info",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show_script_messages",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show_tile_num",
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
        "id": "game.sound.debug_sfxc",
        "control": "checkbox"
       }
      ]
     }
    ]
   }
  ]
 },
 {
  "id": "f2_res.ini",
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
        "id": "hires.MAIN.GRAPHICS_MODE",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.MAIN.SCALE_2X",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.EFFECTS.IS_GRAY_SCALE",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.MAIN.WINDOWED",
        "control": "radio"
       },
       {
        "kind": "setting",
        "id": "hires.MAIN.WINDOWED_FULLSCREEN",
        "control": "checkbox"
       },
       {
        "kind": "frame",
        "title": "Fullscreen",
        "items": [
         {
          "kind": "setting",
          "id": "hires.MAIN.COLOUR_BITS",
          "control": "dropdown"
         },
         {
          "kind": "setting",
          "id": "hires.MAIN.REFRESH_RATE",
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
          "id": "hires.MAIN.SCR_WIDTH",
          "control": "spin"
         },
         {
          "kind": "setting",
          "id": "hires.MAIN.SCR_HEIGHT",
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
        "id": "hires.MAPS.EDGE_CLIPPING_ON",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.MAPS.IGNORE_MAP_EDGES",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.MAPS.IGNORE_PLAYER_SCROLL_LIMITS",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.MAPS.SCROLL_DIST_X",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "hires.MAPS.SCROLL_DIST_Y",
        "control": "qinput"
       }
      ]
     },
     {
      "kind": "setting",
      "id": "hires.MAPS.NumPathNodes",
      "control": "spin"
     },
     {
      "kind": "frame",
      "title": "Fog of war",
      "items": [
       {
        "kind": "setting",
        "id": "hires.MAPS.FOG_OF_WAR",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.MAPS.FOG_LIGHT_LEVEL",
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
        "id": "hires.OTHER_SETTINGS.SPLASH_SCRN_TIME",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "hires.OTHER_SETTINGS.FADE_TIME_MODIFIER",
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
      "id": "hires.MOVIES.MOVIE_SIZE",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "hires.MAINMENU.MAIN_MENU_SIZE",
      "control": "radio"
     },
     {
      "kind": "frame",
      "title": "HiRes menu backgronud",
      "items": [
       {
        "kind": "setting",
        "id": "hires.MAINMENU.USE_HIRES_IMAGES",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.MAINMENU.MENU_BG_OFFSET_X",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "hires.MAINMENU.MENU_BG_OFFSET_Y",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "hires.MAINMENU.SCALE_BUTTONS_AND_TEXT_MENU",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "setting",
      "id": "hires.STATIC_SCREENS.DEATH_SCRN_SIZE",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "hires.STATIC_SCREENS.END_SLIDE_SIZE",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "hires.STATIC_SCREENS.HELP_SCRN_SIZE",
      "control": "radio"
     },
     {
      "kind": "setting",
      "id": "hires.STATIC_SCREENS.SPLASH_SCRN_SIZE",
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
        "id": "hires.IFACE.IFACE_BAR_MODE",
        "control": "radio"
       },
       {
        "kind": "setting",
        "id": "hires.IFACE.IFACE_BAR_SIDE_ART",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.IFACE.IFACE_BAR_SIDES_ORI",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.IFACE.IFACE_BAR_WIDTH",
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
        "id": "hires.OTHER_SETTINGS.DIALOG_SCRN_BACKGROUND",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.OTHER_SETTINGS.DIALOG_SCRN_ART_FIX",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.OTHER_SETTINGS.BARTER_PC_INV_DROP_FIX",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.INPUT.SCROLLWHEEL_FOCUS_PRIMARY_MENU",
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
        "id": "hires.IFACE.ALTERNATE_AMMO_METRE",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.IFACE.ALTERNATE_AMMO_LIGHT",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "hires.IFACE.ALTERNATE_AMMO_DARK",
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
      "id": "hires.OTHER_SETTINGS.CD_CHECK",
      "control": "checkbox"
     },
     {
      "kind": "frame",
      "title": "Troubleshooting",
      "items": [
       {
        "kind": "setting",
        "id": "hires.INPUT.ALT_MOUSE_INPUT",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.INPUT.EXTRA_WIN_MSG_CHECKS",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.OTHER_SETTINGS.CPU_USAGE_FIX",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.OTHER_SETTINGS.FADE_TIME_RECALCULATE_ON_FADE",
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
        "id": "hires.MAIN.f2_res_dat",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "hires.MAIN.f2_res_patches",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "hires.MAIN.UAC_AWARE",
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
  "id": "ddraw.ini",
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
        "id": "sfall.Speed.Enable",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Speed.SpeedMultiInitial",
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
        "id": "sfall.Graphics.Mode",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Graphics.GraphicsWidth",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Graphics.GraphicsHeight",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Graphics.GPUBlt",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Graphics.AllowDShowMovies",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Graphics.FadeMultiplier",
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
        "id": "sfall.Misc.DamageFormula",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.SaveInCombatFix",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.FastShotFix",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.InventoryApCost",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.QuickPocketsApCostReduction",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.RemoveCriticalTimelimits",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Misc",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Misc.UseFileSystemOverride",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.NPCAutoLevel",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.PartyMemberNonRandomLevelUp",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.SingleCore",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.PlayIdleAnimOnReload",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.CorpseDeleteTime",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.ProcessorIdle",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.SkipOpeningMovies",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.SuperStimExploitFix",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.ExplosionsEmitLight",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.DontTurnOffSneakIfYouRun",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.UseWalkDistance",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.SkipLoadingGameSettings",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.EnableHeroAppearanceMod",
        "control": "dropdown"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Sound",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Sound.NumSoundBuffers",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Sound.AllowSoundForFloats",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Sound.AllowDShowSound",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Paths",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Main.TranslationsINI",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "sfall.Scripts.IniConfigFolder",
        "control": "qinput"
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
      "id": "sfall.Interface.ActionPointsBar",
      "control": "checkbox"
     },
     {
      "kind": "frame",
      "title": "Input",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Input.UseScrollWheel",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Input.MiddleMouse",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "sfall.Input.ReverseMouseButtons",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Input.ReloadWeaponKey",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "sfall.Input.ItemFastMoveKey",
        "control": "qinput"
       },
       {
        "kind": "setting",
        "id": "sfall.Input.FastMoveFromContainer",
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
        "id": "sfall.Misc.CombatPanelAnimDelay",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.DialogPanelAnimDelay",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.PipboyTimeAnimDelay",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.SpeedInterfaceCounterAnims",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.InstantWeaponEquip",
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
        "id": "sfall.Misc.NumbersInDialogue",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.EnableMusicInDialogue",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.PartyMemberExtraInfo",
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
        "id": "sfall.Misc.StackEmptyWeapons",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.ReloadReserve",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.ItemCounterDefaultMax",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.DisplayBonusDamage",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.SpeedInventoryPCRotation",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Barter",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Interface.ExpandBarter",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.FullItemDescInBarter",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.ItemCounterAutoCaps",
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
        "id": "sfall.Misc.ExtraSaveSlots",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.AutoQuickSave",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.AutoQuickSavePage",
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
        "id": "sfall.Misc.DisplaySwiftLearnerExp",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.ActiveGeigerMsgs",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.DisplayKarmaChanges",
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
      "id": "sfall.Interface.ExpandWorldMap",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "sfall.Interface.WorldMapTravelMarkers",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.Interface.WorldMapTerrainInfo",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.WorldMapTimeMod",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.WorldMapFPSPatch",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.WorldMapDelay2",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.WorldMapEncounterFix",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.WorldMapEncounterRate",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.WorldMapFontPatch",
      "control": "checkbox"
     }
    ]
   },
   {
    "title": "Debug",
    "items": [
     {
      "kind": "setting",
      "id": "sfall.Debugging.DebugMode",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "sfall.Debugging.AllowUnsafeScripting",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "sfall.Debugging.Init",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.Debugging.Hook",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.Debugging.Script",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.Debugging.Criticals",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "sfall.Debugging.Fixes",
      "control": "checkbox"
     }
    ]
   }
  ]
 },
 {
  "id": "fallout2-ce",
  "label": "CE",
  "engine": "fallout2-ce",
  "tabs": [
   {
    "title": "Screen",
    "items": [
     {
      "kind": "setting",
      "id": "game.screen.windowed",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "game.screen.mouse_lock",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.screen.scale",
      "control": "spin"
     },
     {
      "kind": "frame",
      "title": "Resolution",
      "items": [
       {
        "kind": "setting",
        "id": "hires.MAIN.SCR_WIDTH",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "hires.MAIN.SCR_HEIGHT",
        "control": "spin"
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
      "id": "sfall.Interface.ActionPointsBar",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.ui.main_menu_scale_mode",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "game.ui.in_game_menu_help",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.ui.perks_progress_bar",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.ui.alternate_ammo_meter",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "game.ui.movie_aspect_fit",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.ui.edg_support",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.ui.quick_toolbar_visible",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.ui.anim_speed",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.ui.dialog_border",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.ui.enable_high_resolution_stencil",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.ui.inventory_columns",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.ui.loot_weight_indicator",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "game.ui.loot_container_size_indicator_threshold",
      "control": "spin"
     },
     {
      "kind": "frame",
      "title": "Misc",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Misc.SkipOpeningMovies",
        "control": "dropdown"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Dialog",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Misc.NumbersInDialogue",
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
        "id": "sfall.Misc.DisplayBonusDamage",
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
        "id": "sfall.Misc.AutoQuickSave",
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
        "id": "sfall.Misc.DisplayKarmaChanges",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Maps",
      "items": [
       {
        "kind": "setting",
        "id": "hires.MAPS.IGNORE_MAP_EDGES",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "hires.MAPS.IGNORE_PLAYER_SCROLL_LIMITS",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Scaling",
      "items": [
       {
        "kind": "setting",
        "id": "hires.STATIC_SCREENS.SPLASH_SCRN_SIZE",
        "control": "dropdown"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Interface bar",
      "items": [
       {
        "kind": "setting",
        "id": "hires.IFACE.IFACE_BAR_MODE",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.IFACE.IFACE_BAR_SIDE_ART",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.IFACE.IFACE_BAR_SIDES_ORI",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "hires.IFACE.IFACE_BAR_WIDTH",
        "control": "spin"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Barter",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Interface.ExpandBarter",
        "control": "checkbox"
       }
      ]
     }
    ]
   },
   {
    "title": "Quality of life",
    "items": [
     {
      "kind": "setting",
      "id": "game.qol.use_walk_distance",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.qol.auto_open_doors",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.qol.party_trade_from_menu",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.qol.party_loot_and_barter",
      "control": "checkbox"
     }
    ]
   },
   {
    "title": "Gameplay",
    "items": [
     {
      "kind": "setting",
      "id": "game.gameplay.perk_carryover",
      "control": "dropdown"
     }
    ]
   },
   {
    "title": "Combat",
    "items": [
     {
      "kind": "setting",
      "id": "sfall.Misc.DamageFormula",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.InventoryApCost",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.QuickPocketsApCostReduction",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "sfall.Misc.RemoveCriticalTimelimits",
      "control": "checkbox"
     }
    ]
   },
   {
    "title": "Explosions",
    "items": [
     {
      "kind": "frame",
      "title": "Misc",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Misc.ExplosionsEmitLight",
        "control": "checkbox"
       }
      ]
     }
    ]
   },
   {
    "title": "World map",
    "items": [
     {
      "kind": "frame",
      "title": "Worldmap",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Interface.WorldMapTravelMarkers",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "sfall.Interface.WorldMapTerrainInfo",
        "control": "checkbox"
       }
      ]
     }
    ]
   },
   {
    "title": "Preferences",
    "items": [
     {
      "kind": "setting",
      "id": "game.preferences.running_burning_guy",
      "control": "checkbox"
     }
    ]
   },
   {
    "title": "Sound",
    "items": [
     {
      "kind": "setting",
      "id": "game.sound.gapless_music",
      "control": "spin"
     }
    ]
   },
   {
    "title": "System",
    "items": [
     {
      "kind": "setting",
      "id": "hires.MAIN.f2_res_dat",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.system.screenshots_format",
      "control": "qinput"
     }
    ]
   },
   {
    "title": "Debug",
    "items": [
     {
      "kind": "setting",
      "id": "game.debug.show_fps",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.debug.window_width",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.debug.window_height",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.debug.console_output_path",
      "control": "qinput"
     }
    ]
   }
  ]
 },
 {
  "id": "fission",
  "label": "Fission",
  "engine": "fission",
  "tabs": [
   {
    "title": "Graphics",
    "items": [
     {
      "kind": "setting",
      "id": "game.ui.enable_high_resolution_stencil",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.graphics.fullscreen",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.graphics.stretch_enabled",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.graphics.preserve_aspect",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.graphics.high_quality",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.graphics.widescreen",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.graphics.square_pixels",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.graphics.play_area",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "fission.graphics.widescreen_variant_suffix",
      "control": "qinput"
     }
    ]
   },
   {
    "title": "Enhancements",
    "items": [
     {
      "kind": "setting",
      "id": "game.sound.gapless_music",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.qol.auto_open_doors",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.enhancements.StrictVanilla",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.enhancements.AutoQuickSave",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "fission.enhancements.MassHighlight",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.enhancements.GameSpeed",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.enhancements.AutoPush",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.enhancements.Minimap",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "fission.enhancements.InventoryColumns",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "fission.enhancements.NpcArmor",
      "control": "checkbox"
     },
     {
      "kind": "frame",
      "title": "Misc",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Misc.SkipOpeningMovies",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "sfall.Misc.ExplosionsEmitLight",
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
        "id": "sfall.Misc.NumbersInDialogue",
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
        "id": "sfall.Misc.DisplayBonusDamage",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "PDA",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Misc.DisplayKarmaChanges",
        "control": "checkbox"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Combat",
      "items": [
       {
        "kind": "setting",
        "id": "sfall.Misc.RemoveCriticalTimelimits",
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
        "id": "sfall.Interface.ExpandBarter",
        "control": "checkbox"
       }
      ]
     }
    ]
   },
   {
    "title": "Preferences",
    "items": [
     {
      "kind": "setting",
      "id": "game.preferences.brightness",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.preferences.game_difficulty",
      "control": "dropdown"
     },
     {
      "kind": "setting",
      "id": "game.preferences.item_highlight",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.language_filter",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.preferences.mouse_sensitivity",
      "control": "spin"
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
      "id": "game.preferences.text_base_delay",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.preferences.text_line_delay",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.preferences.running_burning_guy",
      "control": "checkbox"
     },
     {
      "kind": "frame",
      "title": "Combat",
      "items": [
       {
        "kind": "setting",
        "id": "game.preferences.combat_difficulty",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "game.preferences.combat_looks",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.preferences.combat_messages",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "game.preferences.combat_taunts",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.preferences.target_highlight",
        "control": "dropdown"
       },
       {
        "kind": "setting",
        "id": "game.preferences.violence_level",
        "control": "dropdown"
       }
      ]
     },
     {
      "kind": "frame",
      "title": "Speed",
      "items": [
       {
        "kind": "setting",
        "id": "game.preferences.combat_speed",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.preferences.player_speedup",
        "control": "checkbox"
       }
      ]
     }
    ]
   },
   {
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
      "id": "game.sound.music_path1",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.sound.music_path2",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.sound.cache_size",
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
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.sound.initialize",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.sound.irq",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.sound.port",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.sound.debug",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.sound.debug_sfxc",
      "control": "checkbox"
     },
     {
      "kind": "frame",
      "title": "Sound volume",
      "items": [
       {
        "kind": "setting",
        "id": "game.sound.master_volume",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.sound.music_volume",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.sound.sndfx_volume",
        "control": "spin"
       },
       {
        "kind": "setting",
        "id": "game.sound.speech_volume",
        "control": "spin"
       }
      ]
     }
    ]
   },
   {
    "title": "System",
    "items": [
     {
      "kind": "setting",
      "id": "game.system.art_cache_size",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.system.color_cycling",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.system.critter_dat",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.system.critter_patches",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.system.cycle_speed_factor",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.system.executable",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.system.free_space",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "game.system.hashing",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.system.interrupt_walk",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.system.language",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.system.master_dat",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.system.master_patches",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "game.system.scroll_lock",
      "control": "checkbox"
     },
     {
      "kind": "setting",
      "id": "game.system.splash",
      "control": "spin"
     },
     {
      "kind": "setting",
      "id": "fission.system.fission_dat",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "fission.system.fission_patches",
      "control": "qinput"
     },
     {
      "kind": "setting",
      "id": "fission.system.master_override",
      "control": "checkbox"
     }
    ]
   },
   {
    "title": "Debug",
    "items": [
     {
      "kind": "setting",
      "id": "fission.debug.write_offsets",
      "control": "checkbox"
     },
     {
      "kind": "frame",
      "title": "Main",
      "items": [
       {
        "kind": "setting",
        "id": "game.debug.output_map_data_info",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show_load_info",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show_script_messages",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.show_tile_num",
        "control": "checkbox"
       },
       {
        "kind": "setting",
        "id": "game.debug.mode",
        "control": "dropdown"
       }
      ]
     }
    ]
   }
  ]
 }
];
