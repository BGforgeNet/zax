#!/usr/bin/env python3

import time
import PySimpleGUIQt as sg
from typing import OrderedDict
import os, io, sys
import json
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import iniparse
import layout
from config import Config, ValueMap
import pprint
pp = pprint.PrettyPrinter(indent=2)

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
    sg.Tab('Game',  [ [layout.layout['fallout2.cfg'] ]]),
    sg.Tab('HiRes', [ [layout.layout['f2_res.ini']   ]])
  ]])],
  [sg.Button('Save')]
]

mods_layout = [[sg.T('This is inside mods')], [sg.In(key='in')]]

left_col = [
  [sg.Text('Game list')],
  [sg.Text('Click a game to manage it')],
  [sg.Listbox(values=games, size=(20, 12), key='-LIST-', enable_events=True)],
  [sg.Button('Add game')],
  [sg.Button('Remove game from list')],
]

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

def game_type(path):
  return "f2"

def config_path(game_path):
  if game_type(game_path) == "f2":
    cfg = 'fallout2.cfg'
  return os.path.join(game_path, cfg)

def get_ini_configs():
  config_dir = 'formats'
  config_files = [os.path.join(config_dir, f) for f in os.listdir(config_dir) if os.path.isfile(os.path.join(config_dir, f)) and f.lower().endswith('.yml')]
  config_files.sort()
  configs = OrderedDict()
  for f in config_files:
    with open(f) as yf:
      data = yaml.load(yf)
    path = data['f2gm']['path']
    configs[path] = data
  return configs

def load_config_values(window: sg.Window, game_path: str):
  configs = get_ini_configs()
  for c in configs:
    cfg = Config(game_path, configs[c]['f2gm']['path'])
    new_values = cfg.window_data()
    for key in new_values:
      window[key](new_values[key])

def handle_event(window: sg.Window, event, values: dict, game_path: str):
  print('event = ' + event)
  if event == '-LIST-':
    load_config_values(window, game_path)
  # else:
  #   configs = get_ini_configs()
  #   for c in configs:
  #     print(c)
  #     config_path = configs[c]['f2gm']['path']
  #     # print(type(layout))
  #     # print(layout)
  #     # layout.handle_custom_event('est')
  #     layout.handle_custom_event(config_path, window, event, values)
  # pp.pprint(values)

def enable_element(key: str, window: sg.Window, values: dict, new_value = None):
  old_value = values[key]
  window[key](text_color=sg.theme_element_text_color()) # must go before disabled state change, or checkbox will flip state
  window[key](disabled=False)
  if new_value is not None:
    window[key](value=new_value)
  else:
    window[key](value=old_value)

def disable_element(key: str, window: sg.Window, values: dict, new_value = None):
  old_value = values[key]
  window[key](text_color='gray')
  window[key](disabled=True)
  if new_value is not None:
    window[key](value=new_value)
  else:
    window[key](value=old_value)


window = sg.Window('f2gm', main_layout, finalize=True)

try:
  game_list = window['-LIST-']
  game_list(set_to_index=0)
except:
  print("no games in list found")

value_map = ValueMap().valuemap

while True:  # Event Loop

  event, values = window.read()
  if event == sg.WIN_CLOSED:
    break
  if event == "Save":
    pp.pprint(values)
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
  handle_event(window, event, values, game_path)


config['games'] = games
with open(f2gm_yml, 'w') as yf:
  yaml.dump(config, yf)
window.close()
