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
  frame("Interface", [
    checkbox(c, 'Interface', 'ActionPointsBar'),
    dropdown(c, 'Interface', 'ExpandWorldMap'),
    checkbox(c, 'Interface', 'WorldMapTravelMarkers'),
    checkbox(c, 'Interface', 'WorldMapTerrainInfo'),
  ]),
  frame("Input", [
    checkbox(c, 'Input', 'UseScrollWheel'),
    qinput(c, 'Input', 'MiddleMouse'),
    checkbox(c, 'Input', 'ReverseMouseButtons'),
    qinput(c, 'Input', 'ReloadWeaponKey'),
    qinput(c, 'Input', 'ItemFastMoveKey'),
  ]),

  frame("Misc", [
    spin(c, 'Misc', 'WorldMapTimeMod'),
    checkbox(c, 'Misc', 'WorldMapFPSPatch'),
    spin(c, 'Misc', 'WorldMapDelay2'),
    checkbox(c, 'Misc', 'WorldMapEncounterFix'),
    spin(c, 'Misc', 'WorldMapEncounterRate'),

    checkbox(c, 'Misc', 'UseFileSystemOverride'),

    dropdown(c, 'Misc', 'DamageFormula'),

    checkbox(c, 'Misc', 'NPCAutoLevel'),

    checkbox(c, 'Misc', 'SingleCore'),

    dropdown(c, 'Misc', 'SaveInCombatFix'),

    checkbox(c, 'Misc', 'DisplayKarmaChanges'),

    checkbox(c, 'Misc', 'PlayIdleAnimOnReload'),

    spin(c, 'Misc', 'CorpseDeleteTime'),

    spin(c, 'Misc', 'ProcessorIdle'),

    dropdown(c, 'Misc', 'SkipOpeningMovies'),

    checkbox(c, 'Misc', 'ExtraSaveSlots'),
    spin(c, 'Misc', 'AutoQuickSave'),
    spin(c, 'Misc', 'AutoQuickSavePage'),

    dropdown(c, 'Misc', 'SpeedInterfaceCounterAnims'),

    checkbox(c, 'Misc', 'DisplayBonusDamage'),
    dropdown(c, 'Misc', 'FastShotFix'),

    checkbox(c, 'Misc', 'SuperStimExploitFix'),

    spin(c, 'Misc', 'InventoryApCost'),
    spin(c, 'Misc', 'QuickPocketsApCostReduction'),

    checkbox(c, 'Misc', 'ExplosionsEmitLight'),

    spin(c, 'Misc', 'CombatPanelAnimDelay'),
    spin(c, 'Misc', 'DialogPanelAnimDelay'),
    spin(c, 'Misc', 'PipboyTimeAnimDelay'),

    checkbox(c, 'Misc', 'StackEmptyWeapons'),
    spin(c, 'Misc', 'ReloadReserve'),
    checkbox(c, 'Misc', 'ItemCounterDefaultMax'),

    checkbox(c, 'Misc', 'EnableMusicInDialogue'),

    checkbox(c, 'Misc', 'DontTurnOffSneakIfYouRun'),

    spin(c, 'Misc', 'UseWalkDistance'),

    checkbox(c, 'Misc', 'ActiveGeigerMsgs'),

    checkbox(c, 'Misc', 'InstantWeaponEquip'),

    checkbox(c, 'Misc', 'NumbersInDialogue'),

    checkbox(c, 'Misc', 'WorldMapFontPatch'),

    checkbox(c, 'Misc', 'FullItemDescInBarter'),

    checkbox(c, 'Misc', 'DisplaySwiftLearnerExp'),

    checkbox(c, 'Misc', 'PartyMemberExtraInfo'),

    dropdown(c, 'Misc', 'SkipLoadingGameSettings'),
  ]),

  frame("Debugging", [
    dropdown(c, 'Debugging', 'DebugMode'),
    checkbox(c, 'Debugging', 'Init'),
    checkbox(c, 'Debugging', 'Hook'),
    checkbox(c, 'Debugging', 'Script'),
    checkbox(c, 'Debugging', 'Criticals'),
    checkbox(c, 'Debugging', 'Fixes'),
  ]),
]

tab_list = [tab(t, tabs[t]) for t in tabs]

layout = sg.TabGroup([tab_list])
