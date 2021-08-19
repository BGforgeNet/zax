#!/usr/bin/env python3

from posixpath import split
from typing import OrderedDict
import PySimpleGUIQt as sg
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys
from .common import *

sg.theme('Dark Brown')

c = get_ini_data('f2_res.ini')

tabs = OrderedDict()

resolution_options = [
  '1920x1080',
  '1600x900',
  '1366x768',
  '1280x1024',
  '1280x800',
  '1280x720',
  '1152x864',
  '1024x768',
  '1024x576',
  '960x720',
  '960x600',
  '960x540',
  '800x600',
  '640x480',
]

resolution = frame("Resolution", [
  # dropdown(c, 'MAIN', 'resolution', readonly=False),
  [
    sg.Text(text="Common options"),
    sg.Combo(resolution_options, readonly=True, size=(155, None), key='f2_res.ini-resolution', enable_events=True, pad=(50,50))
  ],
  [
    sg.Text(text="Custom"),
    sg.Stretch(),
    sg.Spin([i for i in range(640, 3840+1)], initial_value=640, size=(70, None), key='f2_res.ini-MAIN-SCR_WIDTH', enable_events=True),
    sg.Text("x"),
    sg.Spin([i for i in range(480, 2160+1)], initial_value=480, size=(70, None), key='f2_res.ini-MAIN-SCR_HEIGHT', enable_events=True),
  ]
])


tabs['Main'] = [
  # checkbox(c, 'MAIN', 'UAC_AWARE'), # todo: set to 0 always to avoid ini searching
  frame("Graphics", [
    dropdown(c, 'MAIN', 'GRAPHICS_MODE'),
    checkbox(c, 'MAIN', 'SCALE_2X'),
    checkbox(c, 'EFFECTS', 'IS_GRAY_SCALE'),
    radio(c, 'MAIN', 'WINDOWED'),
    # qinput(c, 'MAIN', 'SCR_WIDTH'), # added manually
    # qinput(c, 'MAIN', 'SCR_HEIGHT'),
    frame("Fullscreen", [
      dropdown(c, 'MAIN', 'COLOUR_BITS', size=(100, None)),
      spin(c, 'MAIN', 'REFRESH_RATE'),
    ]),
    resolution,
    checkbox(c, 'MAIN', 'WINDOWED_FULLSCREEN'),
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


def handle_event(window: sg.Window, event, values):
  res_key = 'f2_res.ini-resolution'
  if event == res_key:
    res_x_key = 'f2_res.ini-MAIN-SCR_WIDTH'
    res_y_key = 'f2_res.ini-MAIN-SCR_HEIGHT'
    new_res = values[res_key]
    new_x = int(new_res.split('x')[0])
    new_y = int(new_res.split('x')[1])
    window[res_x_key](new_x)
    window[res_y_key](new_y)
