#!/usr/bin/env python3

from typing import OrderedDict
import PySimpleGUIQt as sg
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys
sg.theme('Dark Brown')
# sg.theme('Material 2')

ini_yml = "ini.yml"

def get_ini_configs():
  ini_config_dir = 'ini_config'
  ini_config_files = [os.path.join(ini_config_dir, f) for f in os.listdir(ini_config_dir) if os.path.isfile(os.path.join(ini_config_dir, f)) and f.lower().endswith('.yml')]
  ini_config_files.sort()
  ini_configs = OrderedDict()
  for f in ini_config_files:
    with open(f) as yf:
      data = yaml.load(yf)
    path = data['path']
    ini_configs[path] = data
  return ini_configs

def add_key(settings_list, item):
  if 'name' in item:
    name = item['name']
  else:
    name = item['key']
  if not 'type' in item or item['type'] == 'bool':
    settings_list.append([sg.Checkbox(name, key=item['key'], enable_events=True)])
  elif item['type'] == 'radio':
    options_list = [sg.T("       " + name)] + [sg.Radio(str(c), item['key']) for c in item['options']]
    settings_list.append(options_list)
  elif item['type'] == 'dropdown':
    try:
      options_list = [sg.T("       " + name)] + [sg.Combo([str(c) for c in item['options']], readonly=True, size=(125, None), key=item['key'], enable_events=True)]
    except:
      options_list = [sg.T("       " + name)] + [sg.Combo([str(item['name']) for c in item['options']], readonly=True, size=(125, None), key=item['key'], enable_events=True)]
    settings_list.append(options_list)
  elif item['type'] == 'slider':
    if not 'min' in item:
      min = 0
    else:
      min = item['min']
    if not 'max' in item:
      max = 100
    else:
      max = item['max']
    if not 'interval' in item:
      interval = (max - min)/10
    else:
      interval = item['interval']
    if 'data_type' in item and item['data_type'] == 'float':
      min = min * item['float_base']
      max = max * item['float_base']
      interval = interval * item['float_base']
    settings_list.append([sg.T(name), sg.Slider(range=(min, max+1), orientation='horizontal', key=item['key'], size=(200, None), tick_interval=interval, enable_events=True)])
  elif item['type'] == 'spin':
    if not 'min' in item:
      min = 0
    else:
      min = item['min']
    if not 'max' in item:
      max = 100
    else:
      max = item['max']
    settings_list.append([sg.Text(name), sg.Spin([i for i in range(min,max+1)], initial_value=0, size=(100, None), key=item['key'])])
  elif item['type'] == 'string':
    settings_list.append([sg.Text(name), sg.InputText("", key=item['key'], size=(100, None)) ])
  return settings_list

def add_frame(settings_list, item):
  frame_layout = []
  for i in item['items']:
    if 'key' in i:
      frame_layout = add_key(frame_layout, i)
  # frame title is broken https://github.com/PySimpleGUI/PySimpleGUI/issues/2733
  layout = [
    [sg.HorizontalSeparator()],
    [sg.T(item['frame'])],
    [sg.Frame('', frame_layout)],
  ]
  settings_list = settings_list + layout
  return settings_list

def ini_config_to_layout(ini_config):
  layout = []
  tab_list = []
  for tab in ini_config['tabs']:
    settings_list = []
    for i in tab['items']:
      if 'key' in i:
        settings_list = add_key(settings_list, i)
      if 'frame' in i:
        settings_list = add_frame(settings_list, i)
    tab_list.append(sg.Tab(tab['tab'], [[sg.Column(settings_list, scrollable=True, size=(500,500))]], tab['tab']))
  layout = [[sg.TabGroup([tab_list], tooltip=ini_config['path'])]]
  return layout

def settings_element():
  tab_layout = []
  tab_list = []
  ini_configs = get_ini_configs()
  for ic in ini_configs:
    print(ic)
    tab_layout = ini_config_to_layout(ini_configs[ic])
    tab_list.append(sg.Tab(ini_configs[ic]['name'], tab_layout))
  layout = [sg.TabGroup([tab_list], tooltip="Settings")]
  # print(layout)
  # window = sg.Window('f2gm', layout, finalize=True)
  # while True:
  #   event, values = window.read()
  #   if event == sg.WIN_CLOSED:
  #     break
  # sys.exit(0)
  return layout

# l = settings_layout()
