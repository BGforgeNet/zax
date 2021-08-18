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
  checkbox(c, 'MAIN', 'UAC_AWARE'), # set to 0 always to avoid ini searching
  dropdown(c, 'MAIN', 'GRAPHICS_MODE'),
  checkbox(c, 'MAIN', 'SCALE_2X'),
  qinput(c, 'MAIN', 'SCR_WIDTH'),
  qinput(c, 'MAIN', 'SCR_HEIGHT'),
  dropdown(c, 'MAIN', 'COLOUR_BITS', size=(100, None)),
  spin(c, 'MAIN', 'REFRESH_RATE'),
  radio(c, 'MAIN', 'WINDOWED'),
  qinput(c, 'MAIN', 'f2_res_dat', size=(200, None)),
  qinput(c, 'MAIN', 'f2_res_patches', size=(200, None)),
  checkbox(c, 'MAIN', 'WINDOWED_FULLSCREEN'),

  checkbox(c, 'INPUT', 'ALT_MOUSE_INPUT'),
  checkbox(c, 'INPUT', 'EXTRA_WIN_MSG_CHECKS'),
  checkbox(c, 'INPUT', 'SCROLLWHEEL_FOCUS_PRIMARY_MENU'),

  checkbox(c, 'EFFECTS', 'IS_GRAY_SCALE'),

  checkbox(c, 'HI_RES_PANEL', 'DISPLAY_LIST_DESCENDING'),

  radio(c, 'MOVIES', 'MOVIE_SIZE'),

  checkbox(c, 'MAPS', 'EDGE_CLIPPING_ON'),
  checkbox(c, 'MAPS', 'IGNORE_MAP_EDGES'),
  checkbox(c, 'MAPS', 'IGNORE_PLAYER_SCROLL_LIMITS'),
  qinput(c, 'MAPS', 'SCROLL_DIST_X'),
  qinput(c, 'MAPS', 'SCROLL_DIST_Y'),
  spin(c, 'MAPS', 'NumPathNodes'),
  checkbox(c, 'MAPS', 'FOG_OF_WAR'),
  spin(c, 'MAPS', 'FOG_LIGHT_LEVEL'),

  radio(c, 'IFACE', 'IFACE_BAR_MODE'),
  radio(c, 'IFACE', 'IFACE_BAR_SIDE_ART'),
  radio(c, 'IFACE', 'IFACE_BAR_SIDES_ORI'),
  spin(c, 'IFACE', 'IFACE_BAR_WIDTH'),
  dropdown(c, 'IFACE', 'ALTERNATE_AMMO_METRE'),
  qinput(c, 'IFACE', 'ALTERNATE_AMMO_LIGHT'),
  qinput(c, 'IFACE', 'ALTERNATE_AMMO_DARK'),

  radio(c, 'MAINMENU', 'MAIN_MENU_SIZE'),
  checkbox(c, 'MAINMENU', 'USE_HIRES_IMAGES'),
  checkbox(c, 'MAINMENU', 'SCALE_BUTTONS_AND_TEXT_MENU'),
  qinput(c, 'MAINMENU', 'MENU_BG_OFFSET_X'),
  qinput(c, 'MAINMENU', 'MENU_BG_OFFSET_Y'),

]

tab_list = [tab(t, tabs[t]) for t in tabs]

layout = sg.TabGroup([tab_list])
