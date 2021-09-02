#!/usr/bin/env python3

from posixpath import split
from typing import OrderedDict
import PySimpleGUIQt as sg
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
from .common import *

sg.theme('Dark Brown')

c = get_ini_data('ddraw.ini')

tabs = OrderedDict()


tabs['Main'] = [
  frame("Speed", [
    checkbox(c, 'Speed', 'Enable'),
    spin(c, 'Speed', 'SpeedMultiInitial'),
  ]),
  frame("Graphics", [
    dropdown(c, 'Graphics', 'Mode'),
    spin(c, 'Graphics', 'GraphicsWidth'),
    spin(c, 'Graphics', 'GraphicsHeight'),
    dropdown(c, 'Graphics', 'GPUBlt'),
    dropdown(c, 'Graphics', 'AllowDShowMovies'),
    spin(c, 'Graphics', 'FadeMultiplier'),
  ]),

  frame("Combat", [
    dropdown(c, 'Misc', 'DamageFormula'),
    dropdown(c, 'Misc', 'SaveInCombatFix'),
    dropdown(c, 'Misc', 'FastShotFix'),
    spin(c, 'Misc', 'InventoryApCost'),
    spin(c, 'Misc', 'QuickPocketsApCostReduction'),
  ]),

  frame("Misc", [

    checkbox(c, 'Misc', 'UseFileSystemOverride'),

    checkbox(c, 'Misc', 'NPCAutoLevel'),

    checkbox(c, 'Misc', 'SingleCore'),

    checkbox(c, 'Misc', 'PlayIdleAnimOnReload'),

    spin(c, 'Misc', 'CorpseDeleteTime'),

    spin(c, 'Misc', 'ProcessorIdle'),

    dropdown(c, 'Misc', 'SkipOpeningMovies'),

    checkbox(c, 'Misc', 'SuperStimExploitFix'),

    checkbox(c, 'Misc', 'ExplosionsEmitLight'),

    checkbox(c, 'Misc', 'DontTurnOffSneakIfYouRun'),

    spin(c, 'Misc', 'UseWalkDistance'),

    dropdown(c, 'Misc', 'SkipLoadingGameSettings'),
  ]),
]

tabs['Interface'] = [
  checkbox(c, 'Interface', 'ActionPointsBar'),
  frame("Input", [
    checkbox(c, 'Input', 'UseScrollWheel'),
    qinput(c, 'Input', 'MiddleMouse'),
    checkbox(c, 'Input', 'ReverseMouseButtons'),
    qinput(c, 'Input', 'ReloadWeaponKey'),
    qinput(c, 'Input', 'ItemFastMoveKey'),
    checkbox(c, 'Input', 'FastMoveFromContainer'),
  ]),
  frame("Animation speed", [
    spin(c, 'Misc', 'CombatPanelAnimDelay'),
    spin(c, 'Misc', 'DialogPanelAnimDelay'),
    spin(c, 'Misc', 'PipboyTimeAnimDelay'),
    dropdown(c, 'Misc', 'SpeedInterfaceCounterAnims'),
    checkbox(c, 'Misc', 'InstantWeaponEquip'),
  ]),
  frame("Dialog", [
    checkbox(c, 'Misc', 'NumbersInDialogue'),
    checkbox(c, 'Misc', 'EnableMusicInDialogue'),
    checkbox(c, 'Misc', 'PartyMemberExtraInfo'),
  ]),
  frame("Inventory", [
    checkbox(c, 'Misc', 'StackEmptyWeapons'),
    spin(c, 'Misc', 'ReloadReserve'),
    checkbox(c, 'Misc', 'ItemCounterDefaultMax'),
    checkbox(c, 'Misc', 'DisplayBonusDamage'),
  ]),
  frame("Barter", [
    checkbox(c, 'Misc', 'FullItemDescInBarter'),
  ]),
  frame("Saves", [
    checkbox(c, 'Misc', 'ExtraSaveSlots'),
    spin(c, 'Misc', 'AutoQuickSave'),
    spin(c, 'Misc', 'AutoQuickSavePage'),
  ]),
  frame("PDA", [
    checkbox(c, 'Misc', 'DisplaySwiftLearnerExp'),
    checkbox(c, 'Misc', 'ActiveGeigerMsgs'),
    checkbox(c, 'Misc', 'DisplayKarmaChanges'),
  ]),
]

tabs['Worldmap'] = [
  dropdown(c, 'Interface', 'ExpandWorldMap'),
  checkbox(c, 'Interface', 'WorldMapTravelMarkers'),
  checkbox(c, 'Interface', 'WorldMapTerrainInfo'),
  spin(c, 'Misc', 'WorldMapTimeMod'),
  checkbox(c, 'Misc', 'WorldMapFPSPatch'),
  spin(c, 'Misc', 'WorldMapDelay2'),
  checkbox(c, 'Misc', 'WorldMapEncounterFix'),
  spin(c, 'Misc', 'WorldMapEncounterRate'),
  checkbox(c, 'Misc', 'WorldMapFontPatch'),
]

tabs['Debug'] = [
  dropdown(c, 'Debugging', 'DebugMode'),
  checkbox(c, 'Debugging', 'Init'),
  checkbox(c, 'Debugging', 'Hook'),
  checkbox(c, 'Debugging', 'Script'),
  checkbox(c, 'Debugging', 'Criticals'),
  checkbox(c, 'Debugging', 'Fixes'),
]

tab_list = [tab(t, tabs[t]) for t in tabs]

layout = sg.TabGroup([tab_list])


def handle_event(window: sg.Window, event: str, values: dict):
  if window[event].metadata == 'dx_key':
    new_value = values[event]
    if len(new_value) > 1:
      new_value = new_value[1]
    if new_value.isascii() and new_value.isprintable():
      window[event](new_value.upper())

  disable_if('ddraw.ini-Speed-Enable', False, 'ddraw.ini-Speed-SpeedMultiInitial', window, values, event)

  disable_if('ddraw.ini-Graphics-Mode', '8 bit fullscreen', 'ddraw.ini-Graphics-GraphicsWidth', window, values, event)
  disable_if('ddraw.ini-Graphics-Mode', '8 bit fullscreen', 'ddraw.ini-Graphics-GraphicsHeight', window, values, event)

  disable_if('ddraw.ini-Misc-WorldMapFPSPatch', False, 'ddraw.ini-Misc-WorldMapDelay2', window, values, event)

  disable_if('ddraw.ini-Misc-WorldMapEncounterFix', False, 'ddraw.ini-Misc-WorldMapEncounterRate', window, values, event)
