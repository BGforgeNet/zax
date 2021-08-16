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
  frame("Combat", [
    radio   (c, 'preferences', 'combat_difficulty'),
    # dropdown(c, 'preferences', 'combat_difficulty'),
    checkbox(c, 'preferences', 'combat_looks'),
    radio   (c, 'preferences', 'combat_messages'),
    slider  (c, 'preferences', 'combat_speed'),
    checkbox(c, 'preferences', 'combat_taunts'),

  #   :
  #   name: Difficulty
  #   type: dropdown
  #   options:
  #     - value: 0
  #       name: Wimpy
  #     - value: 1
  #       name: Normal
  #     - value: 2
  #       name: Rough
  # combat_looks:
  #   name: Looks
  # combat_messages:
  #   name: Messages
  #   type: radio
  #   options:
  #     - value: 0
  #       name: Verbose
  #     - value: 1
  #       name: Brief
  # combat_speed:
  #   name: Speed
  #   type: slider
  #   min: 0
  #   max: 50
  # combat_taunts:
  #   name: Taunts

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

# window = sg.Window('test1', layout=[[layout]], finalize=True)

# while True:
#   event, values = window.read()
#   if event == sg.WIN_CLOSED:
#     break
