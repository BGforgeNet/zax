#!/usr/bin/env python3

import PySimpleGUIQt as sg
from typing import OrderedDict
import os, io
import json
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import iniparse
import layout

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
  # ini_layouts.settings_element(),
  [layout.layout['fallout2.cfg']],
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
    [sg.Tab('Settings', settings_layout, tooltip='Game settings'), sg.Tab('Mods', mods_layout, tooltip='mods')]
  ])
]]

menu_def = [['Settings']]
menu_def = [['File', ['Settings', 'Exit']]]

layout = [[
  sg.Menu(menu_def, tearoff=True),
  sg.Column(left_col, element_justification='c'),
  sg.VSeperator(),
  sg.Column(right_col, size=(500,500))
]]

window = sg.Window('f2gm', layout, finalize=True)

def is_f2_game(path):
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
  config_dir = 'configs'
  config_files = [os.path.join(config_dir, f) for f in os.listdir(config_dir) if os.path.isfile(os.path.join(config_dir, f)) and f.lower().endswith('.yml')]
  config_files.sort()
  configs = OrderedDict()
  for f in config_files:
    with open(f) as yf:
      data = yaml.load(yf)
    path = data['f2gm']['path']
    configs[path] = data
  return configs

def handle_event(window, event, values, game_path):
  if event != '-LIST-':
    return False
  configs = get_ini_configs()
  for f in configs:
    if os.path.isfile(os.path.join(game_path, f)):
      cfg = iniparse.INIConfig(io.open(config_path(game_path)))
      for s in cfg:
        print(s)
        for k in cfg[s]:
          print(k)
          print(cfg[s][k])
          if k in values:
            window[k](value=ini_value_to_window(configs[f], k, cfg[s][k]))
  return True

def ini_value_to_window(ini_config, key, value):
  print(key)
  result = None
  vtype = 'bool'
  for t in ini_config['tabs']:
    for i in t['items']:
      try:
        if 'key' in i and i['key'] == key:
          if i['type'] == 'slider':
            if 'type' in i and i['type'] == 'float':
              value = int(float(value) * i['float_base'])
            vtype = 'int'
      except:
        pass
  value = int(value)
  print(value)
  if vtype == 'bool':
    if value == 1:
      result = True
    if value == 0:
      result = False
  return result


def enable_element(key, window, values, new_value = None):
  old_value = values[key]
  window[key].update(text_color=sg.theme_element_text_color()) # must go before disabled state change, or checkbox will flip state
  window[key].update(disabled=False)
  if new_value is not None:
    window[key](value=new_value)
  else:
    window[key](value=old_value)

def disable_element(key, window, values, new_value = None):
  old_value = values[key]
  window[key].update(text_color='gray')
  window[key].update(disabled=True)
  if new_value is not None:
    window[key](value=new_value)
  else:
    window[key](value=old_value)


while True:  # Event Loop

  event, values = window.read()
  print(event)
  if event == sg.WIN_CLOSED:
    break
  if event == "Save":
    print(values)
  if event == "Add game":
    dname = sg.popup_get_folder('Enter game path')
    if is_f2_game(dname):
      games = sorted(list(set(games + [dname])))
      window.Element('-LIST-').Update(values=games)
    else:
      sg.popup("fallout2.exe not found in directory {}".format(dname))
  if values['-LIST-']:
    game_path = values['-LIST-'][0]
    handle_event(window, event, values, game_path)


config['games'] = games
with open(f2gm_yml, 'w') as yf:
  yaml.dump(config, yf)
window.close()
