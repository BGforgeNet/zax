#!/usr/bin/env python3

from typing import OrderedDict
import PySimpleGUIQt as sg
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys
from .common import *

sg.theme('Dark Brown')

c = get_ini_data('fallout2.cfg')

tabs = OrderedDict()

tabs['Preferences'] = [
  slider  (c, 'preferences', 'brightness'),
  radio   (c, 'preferences', 'game_difficulty'),
  checkbox(c, 'preferences', 'item_highlight'),
  checkbox(c, 'preferences', 'language_filter'),
  slider  (c, 'preferences', 'mouse_sensitivity'),
  checkbox(c, 'preferences', 'running'),
  checkbox(c, 'preferences', 'subtitles'),
  slider  (c, 'preferences', 'text_base_delay'),
  slider  (c, 'preferences', 'text_line_delay'),
]
tabs['Combat'] = [
  radio   (c, 'preferences', 'combat_difficulty'),
  frame("Speed", [
    slider  (c, 'preferences', 'combat_speed'),
    checkbox(c, 'preferences', 'player_speedup'),
  ]),
  checkbox(c, 'preferences', 'combat_looks'),
  radio   (c, 'preferences', 'combat_messages'),
  checkbox(c, 'preferences', 'combat_taunts'),
  checkbox(c, 'preferences', 'target_highlight'),
  dropdown(c, 'preferences', 'violence_level'),
]

tabs['Advanced'] = [
  frame("System", [
    spin(c, 'system', 'art_cache_size'),
    checkbox(c, 'system', 'color_cycling'),
    qinput(c, 'system', 'critter_dat'),
    qinput(c, 'system', 'critter_patches'),
    spin(c, 'system', 'cycle_speed_factor'),
    qinput(c, 'system', 'executable'),
    spin(c, 'system', 'free_space'),
    checkbox(c, 'system', 'hashing'),
    checkbox(c, 'system', 'interrupt_walk'),
    qinput(c, 'system', 'language'),
    qinput(c, 'system', 'master_dat'),
    qinput(c, 'system', 'master_patches'),
    checkbox(c, 'system', 'scroll_lock'),
    spin(c, 'system', 'splash'),
  ]),
  frame("Sound", [
    checkbox(c, 'sound', 'music'),
    checkbox(c, 'sound', 'sounds'),
    checkbox(c, 'sound', 'speech'),
    qinput(c, 'sound', 'music_path1', size=(200, None)),
    qinput(c, 'sound', 'music_path2', size=(200, None)),
    spin(c, 'sound', 'cache_size'),
    qinput(c, 'sound', 'device'),
    qinput(c, 'sound', 'dma'),
    checkbox(c, 'sound', 'initialize'),
    qinput(c, 'sound', 'irq'),
    qinput(c, 'sound', 'port'),
  ])
]

tabs['Debug'] = [
  frame('Main', [
    checkbox(c, 'debug', 'output_map_data_info'),
    checkbox(c, 'debug', 'show_load_info'),
    checkbox(c, 'debug', 'show_script_messages'),
    checkbox(c, 'debug', 'show_tile_num'),
  ]),
  frame("Sound", [
    checkbox(c, 'sound', 'debug'),
    checkbox(c, 'sound', 'debug_sfxc'),
  ])
]


tab_list = [tab(t, tabs[t]) for t in tabs]

layout = sg.TabGroup([tab_list])

