#!/usr/bin/env python3

import requests
import subprocess
import time
import PySimpleGUIQt as sg
from typing import OrderedDict
import os, io, sys
import json
from PySimpleGUIQt.PySimpleGUIQt import SELECT_MODE_SINGLE
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import iniparse
import layout
from config import GameConfig
import pprint
pp = pprint.PrettyPrinter(indent=2)
import sfall

sg.theme('Dark Brown')
# sg.theme('material 2')


f2gm_yml = "f2gm.yml"
config = {}
games = []
if os.path.isfile(f2gm_yml):
  try:
    with open(f2gm_yml) as yf:
      config = yaml.load(yf)
    games = config["games"]
  except:
    pass

settings_layout = [
  [sg.TabGroup([[
    sg.Tab('Game', [ [layout.layout['fallout2.cfg']] ], key='tab-fallout2.cfg'),
    sg.Tab('HiRes', [ [layout.layout['f2_res.ini']] ], key='tab-f2_res.ini'),
    sg.Tab('Sfall', [ [layout.layout['ddraw.ini']] ], key='tab-ddraw.ini')
  ]], enable_events=True, key='tab-settings-sub')],
  [sg.Button('Save')],
  # checkbox is a hack for triggering event to disable elements after config loading
  [sg.Checkbox('configs_loaded', key='configs_loaded', enable_events=True, visible=False)]
]

mods_layout = [[sg.T('This is inside mods')], [sg.In(key='in')]]
games_layout = [
  [sg.Text('Click a game to manage it')],
  [sg.Listbox(values=games, size=(21, 15), key='-LIST-', enable_events=True, select_mode=SELECT_MODE_SINGLE)],
  [sg.Button('Add game')],
  [sg.Button('Remove game from list')],
]
left_col = [[
  sg.TabGroup([
    [sg.Tab('Games', games_layout)]
  ])
]]

right_col = [[
  sg.TabGroup([
    [sg.Tab('Settings', settings_layout), sg.Tab('Mods', mods_layout, tooltip='mods')]
  ])
]]

menu_def = [['Settings']]
menu_def = [['File', ['Settings', 'Exit']]]

main_layout = [[
  sg.Menu(menu_def, tearoff=True),
  sg.Column(left_col, element_justification='c'),
  sg.VSeperator(),
  sg.Column(right_col, size=(500,500))
]]

def is_f2_game(path: str):
  if path is not None:
    if os.path.isdir(dname):
      files = [f.lower() for f in os.listdir(dname) if os.path.isfile(os.path.join(dname, f))]
      if "fallout2.exe" in files:
        return True
  return False

def handle_event(window: sg.Window, event, values: dict, game_path: str, game_config):
  if event == '-LIST-':
    window['configs_loaded'](False)
    game_config = GameConfig(game_path)
    game_config.load_from_disk(window, values)
  config_paths = game_config.config_paths
  for p in config_paths:
    layout.handle_custom_event(p, window, event, values)
  if event == '-LIST-':
    window['configs_loaded'](True)
  return game_config

sfall_latest = sfall.get_latest()

window = sg.Window('f2gm', main_layout, finalize=True)

try:
  game_list = window['-LIST-']
  game_list(set_to_index=0)
  print('found games!')
except:
  print("no games in list found")
window['configs_loaded'](False)

game_config = None
while True:  # Event Loop

  event, values = window.read()

  print("event = {}".format(event))
  if event == sg.WIN_CLOSED:
    break
  if event == "Save":
    game_config.save(values)

  if event == "Add game":
    dname = sg.popup_get_folder('Enter game path')
    if is_f2_game(dname):
      games = sorted(list(set(games + [dname])))
      window['-LIST-'](values=games)
      new_game_index = games.index(dname)
      game_list(set_to_index=new_game_index)
    else:
      sg.popup("fallout2.exe not found in directory {}".format(dname))
  if values['-LIST-']:
    game_path = values['-LIST-'][0]
    sfall_ver = sfall.get_current(game_path)
    window['sfall_current'](value=sfall_ver)
    window['sfall_latest'](value=sfall_latest['ver'])

  game_config = handle_event(window, event, values, game_path, game_config)


config['games'] = games
with open(f2gm_yml, 'w') as yf:
  yaml.dump(config, yf)
window.close()
