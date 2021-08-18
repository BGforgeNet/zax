#!/usr/bin/env python3

from typing import OrderedDict
import PySimpleGUIQt as sg
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys
from .common import *

sg.theme('Dark Brown')

c = get_ini_data('f2_res.ini')

tabs = OrderedDict()

tabs['Main'] = [
  # checkbox(c, 'MAIN', 'UAC_AWARE'), # set to 0 always to avoid ini searching
  frame("Graphics", [
    dropdown(c, 'MAIN', 'GRAPHICS_MODE'),
    checkbox(c, 'MAIN', 'SCALE_2X'),
    # qinput(c, 'MAIN', 'SCR_WIDTH'),
    # qinput(c, 'MAIN', 'SCR_HEIGHT'),
    dropdown(c, 'MAIN', 'resolution', readonly=False),
    radio(c, 'MAIN', 'WINDOWED'),
    frame("Fullscreen", [
      dropdown(c, 'MAIN', 'COLOUR_BITS', size=(100, None)),
      spin(c, 'MAIN', 'REFRESH_RATE'),
    ]),
    checkbox(c, 'MAIN', 'WINDOWED_FULLSCREEN'),
    checkbox(c, 'EFFECTS', 'IS_GRAY_SCALE'),
  ]),

  # checkbox(c, 'HI_RES_PANEL', 'DISPLAY_LIST_DESCENDING'), # useless
  frame("Maps", [
    checkbox(c, 'MAPS', 'EDGE_CLIPPING_ON'),
    checkbox(c, 'MAPS', 'IGNORE_MAP_EDGES'),
    checkbox(c, 'MAPS', 'IGNORE_PLAYER_SCROLL_LIMITS'),
    qinput(c, 'MAPS', 'SCROLL_DIST_X'),
    qinput(c, 'MAPS', 'SCROLL_DIST_Y'),
  ]),

  spin(c, 'MAPS', 'NumPathNodes'),

  frame("Fog of war", [
    checkbox(c, 'MAPS', 'FOG_OF_WAR'),
    spin(c, 'MAPS', 'FOG_LIGHT_LEVEL'),
  ]),

  frame("Delays", [
    spin(c, 'OTHER_SETTINGS', 'SPLASH_SCRN_TIME'),
    spin(c, 'OTHER_SETTINGS', 'FADE_TIME_MODIFIER'),
  ]),
]

tabs["Scaling"] = [
  radio(c, 'MOVIES', 'MOVIE_SIZE'),
  radio(c, 'MAINMENU', 'MAIN_MENU_SIZE'),
  frame("HiRes menu backgronud", [
    checkbox(c, 'MAINMENU', 'USE_HIRES_IMAGES'),
    spin(c, 'MAINMENU', 'MENU_BG_OFFSET_X'),
    spin(c, 'MAINMENU', 'MENU_BG_OFFSET_Y'),
  ]),
  checkbox(c, 'MAINMENU', 'SCALE_BUTTONS_AND_TEXT_MENU'),
  radio(c, 'STATIC_SCREENS', 'DEATH_SCRN_SIZE'),
  radio(c, 'STATIC_SCREENS', 'END_SLIDE_SIZE'),
  radio(c, 'STATIC_SCREENS', 'HELP_SCRN_SIZE'),
  radio(c, 'STATIC_SCREENS', 'SPLASH_SCRN_SIZE'),
]

tabs['Interface'] = [
  frame("Interface bar", [
    radio(c, 'IFACE', 'IFACE_BAR_MODE'),
    dropdown(c, 'IFACE', 'IFACE_BAR_SIDE_ART', size=(180, None)),
    dropdown(c, 'IFACE', 'IFACE_BAR_SIDES_ORI', size=(180, None)),
    spin(c, 'IFACE', 'IFACE_BAR_WIDTH'),
  ]),
  frame("Dialog and barter", [
    checkbox(c, 'OTHER_SETTINGS', 'DIALOG_SCRN_BACKGROUND'),
    checkbox(c, 'OTHER_SETTINGS', 'DIALOG_SCRN_ART_FIX'),
    checkbox(c, 'OTHER_SETTINGS', 'BARTER_PC_INV_DROP_FIX'),
    checkbox(c, 'INPUT', 'SCROLLWHEEL_FOCUS_PRIMARY_MENU'),
  ]),
  frame("Alternate ammo metre", [
    dropdown(c, 'IFACE', 'ALTERNATE_AMMO_METRE'),
    qinput(c, 'IFACE', 'ALTERNATE_AMMO_LIGHT'),
    qinput(c, 'IFACE', 'ALTERNATE_AMMO_DARK'),
  ]),
]

tabs['Advanced'] = [
  checkbox(c, 'OTHER_SETTINGS', 'CD_CHECK'),
  frame("Troubleshooting", [
    checkbox(c, 'INPUT', 'ALT_MOUSE_INPUT'),
    checkbox(c, 'INPUT', 'EXTRA_WIN_MSG_CHECKS'),
    checkbox(c, 'OTHER_SETTINGS', 'CPU_USAGE_FIX'),
    checkbox(c, 'OTHER_SETTINGS', 'FADE_TIME_RECALCULATE_ON_FADE'),
  ]),
  frame("System", [
    qinput(c, 'MAIN', 'f2_res_dat', size=(200, None)),
    qinput(c, 'MAIN', 'f2_res_patches', size=(200, None)),
  ]),
]
tab_list = [tab(t, tabs[t]) for t in tabs]

layout = sg.TabGroup([tab_list])
