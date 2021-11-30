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
from config import GameConfig, winkey2ini
import sfall
import threading
import queue
import tempfile
from variables import *
import platform
import wine
from common import cd
from packaging import version
from zax_log import log

sg.theme('Dark Brown')
gui_queue = queue.Queue()  # queue used to communicate between the gui and the threads
# sg.theme('material 2')

def get_game_paths(games):
  game_paths = [g['path'] for g in games]
  game_paths = sorted(list(set(game_paths)))
  return game_paths

appname = 'zax'
zax_yml = os.path.join(config_dir, "zax.yml")
config = {}
games = []
if os.path.isfile(zax_yml):
  try:
    with open(zax_yml) as yf:
      config = yaml.load(yf)
    games = config["games"]
    game_paths = get_game_paths(games)
  except:
    os.makedirs(config_dir, exist_ok=True)

if platform.system() != "Windows":
  wine_visible = True
settings_tabs = [
  sg.Tab('Game',  [ [layout.layout['fallout2.cfg']] ],  key='tab-fallout2.cfg'),
  sg.Tab('HiRes', [ [layout.layout['f2_res.ini']] ],    key='tab-f2_res.ini'),
  sg.Tab('Sfall', [ [layout.layout['ddraw.ini']] ],     key='tab-ddraw.ini'),
  sg.Tab('Wine',  layout.layout['wine'],          key='tab-wine', visible=wine_visible)
]

settings_layout = [
  [sg.TabGroup([settings_tabs], enable_events=True, key='tab-settings-sub')],
  [sg.Button('Save')],
  [sg.Button('Play', key='play')],
  # checkbox is a hack for triggering event to disable elements after config loading
  [sg.Checkbox('configs_loaded', key='configs_loaded', enable_events=True, visible=False)]
]

mods_layout = [[sg.T('This is inside mods')], [sg.In(key='in')]]
games_layout = [
  [sg.Text('Click a game to manage it')],
  [sg.Listbox(values=game_paths, size=(21, 15), key='-LIST-', enable_events=True, select_mode=SELECT_MODE_SINGLE)],
  [sg.Button('Add game')],
  [sg.Button('Remove from list')],
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
  if event == '-LIST-' or event == 'btn_sfall_update':
    window['configs_loaded'](False)
    game_config = GameConfig(game_path)
    game_config.load_from_disk(window, values)
  config_paths = game_config.config_paths
  for p in config_paths:
    layout.handle_custom_event(p, window, event, values)
  if event == '-LIST-':
    window['configs_loaded'](True)
  return game_config


def launch_game(path, wine_prefix=None, wine_debug=None, sfall_version=None):
  try:
    subprocess.CREATE_NEW_PROCESS_GROUP
  except AttributeError:
    my_env = os.environ.copy()
    if wine_prefix and wine_prefix != '':
      my_env["WINEPREFIX"] = wine_prefix
    if wine_debug and wine_debug != '':
      my_env["WINEDEBUG"] = wine_debug
    if version.parse(sfall_version) < version.parse("4.1.2"):
      my_env["WINEDLLOVERRIDES"] = "ddraw.dll=n"
    else:
      my_env["WINEDLLOVERRIDES"] = "ddraw.dll=n,b"
    # not Windows, so assume POSIX; if not, we'll get a usable exception
    args = ['wine', 'fallout2.exe']
    p = subprocess.Popen(args, cwd=path, start_new_session=True, env=my_env)
  else:
    # Windows
    args = 'fallout2.exe'
    p = subprocess.Popen(args, cwd=path, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)

window = sg.Window('zax', main_layout, finalize=True)

try:
  game_list = window['-LIST-']
  game_list(set_to_index=0)
  log('found games!')
except:
  log("no games in list found")
window['configs_loaded'](False)

sfall_latest = None
game_config = None
while True:  # Event Loop

  event, values = window.read()

  log("event = {}".format(event))
  if event == sg.WIN_CLOSED:
    break
  if event == "Save":
    game_config.save(values)
    wine.save(zax_yml, config, games, game_path, values)
  if event == "play":
    launch_game(game_path, wine_prefix=values['wine_prefix'], wine_debug=values['wine_debug'], sfall_version=sfall_current)

  if event == "Add game":
    dname = sg.popup_get_folder('Enter game path')
    if is_f2_game(dname):
      games.append({'path': dname})
      game_paths = get_game_paths(games)
      window['-LIST-'](values=game_paths)
      new_game_index = game_paths.index(dname)
      game_list(set_to_index=new_game_index)
    else:
      sg.popup("fallout2.exe not found in directory {}".format(dname))

  if event == '-LIST-' and values['-LIST-']:
    game_path = values['-LIST-'][0]
    sfall_current = sfall.get_current(game_path)
    window['txt_sfall_current'](value=sfall_current)
    if sfall_latest is None:
      sfall.launch_latest_check(gui_queue)
    else:
      sfall_latest = sfall.handle_update_ui(window, sfall_current, sfall_latest=sfall_latest)
    wine.load(games, game_path, window)

  # background process handling
  try:
    message = gui_queue.get_nowait()
  except queue.Empty:     # get_nowait() will get exception when Queue is empty
    message = None        # break from the loop if no more messages are queued up
  if message:             # if message received from queue, display the message in the Window
    log('Got a message back from the thread: ', message)
    if message['type'] == 'sfall_latest':
      sfall_latest = sfall.handle_update_ui(window, sfall_current, message=message)

  if event == 'btn_sfall_update':
    sfall.update(window, sfall_latest, game_path)

  game_config = handle_event(window, event, values, game_path, game_config)


config['games'] = games
with open(zax_yml, 'w') as yf:
  yaml.dump(config, yf)
window.close()
