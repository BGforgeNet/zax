#!/usr/bin/env python3

from typing import OrderedDict
import PySimpleGUIQt as sg
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys
import pprint
pp = pprint.PrettyPrinter(indent=2)


def get_ini_data(filename):
  # with open( os.path.join( os.path.realpath('..'), "configs", filename + '.yml') ) as yf:
  with open( os.path.join( "formats", filename + '.yml') ) as yf:
    data = yaml.load(yf)
  return data

def checkbox(cfg_data, section, key, visible=True, disabled=False):
  item = cfg_data[section][key]
  try:
    name = item['name']
  except:
    name = key
  try:
    tooltip = item['desc']
  except:
    tooltip = None
  return [sg.Checkbox(name, key="{}-{}-{}".format(cfg_data['f2gm']['path'], section, key), enable_events=True, tooltip=tooltip, visible=visible, disabled=disabled)]

def tab(tab_name, items):
  return sg.Tab(tab_name, [[sg.Column(items, scrollable=True, size=(500,500))]])

def frame(name, items):
  # frame title is broken https://github.com/PySimpleGUI/PySimpleGUI/issues/2733
  # return [sg.Frame(name, items)]
  return [sg.Frame('', [
    [sg.HorizontalSeparator()],
    [sg.T(name)],
    [sg.Frame('', items)] 
  ])]

def name_wkey(cfg_data, section, key):
  item = cfg_data[section][key]
  try:
    name = item['name']
  except:
    name = key
  wkey = "{}-{}-{}".format(cfg_data['f2gm']['path'], section, key)
  return name, wkey

def dropdown(cfg_data, section, key, size=(150, None), readonly=True):
  item = cfg_data[section][key]
  name, wkey= name_wkey(cfg_data, section, key)
  options = [str(o['name']) for o in item['options']]
  return [
    sg.T("       " + name),
    sg.Combo(options, readonly=readonly, size=size, key=wkey, enable_events=True, pad=(50,50))
  ] # combo size/justification is broken https://github.com/PySimpleGUI/PySimpleGUI/issues/4474

def radio(cfg_data, section, key):
  item = cfg_data[section][key]
  name, wkey= name_wkey(cfg_data, section, key)
  options = {o['name']: o['value'] for o in item['options']}
  return [sg.T("       " + name), sg.Stretch()] + [sg.Radio(o, wkey, key='{}-{}'.format(wkey, options[o]), enable_events=True) for o in options]

def slider(cfg_data, section, key, visible=True):
  item = cfg_data[section][key]
  name, wkey= name_wkey(cfg_data, section, key)
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
  if 'type' in item and item['type'] == 'float':
    min = min * item['float_base']
    max = max * item['float_base']
    interval = interval * item['float_base']
  return [
    sg.T("       " + name, visible=visible),
    sg.Slider(range=(min, max+1), orientation='horizontal', key=wkey, size=(200, None), tick_interval=interval, enable_events=True, visible=visible)]

def spin(cfg_data, section, key):
  item = cfg_data[section][key]
  name, wkey= name_wkey(cfg_data, section, key)
  if not 'min' in item:
    min = 0
  else:
    min = item['min']
  if not 'max' in item:
    if 'min' in item:
      max = abs(min) * 2 # just a guess
    else:
      max = 100
  else:
    max = item['max']
  try:
    tooltip = item['desc']
  except:
    tooltip = None
  return [sg.Text("       " + name), sg.Spin([i for i in range(min,max+1)], initial_value=0, size=(100, None), key=wkey, enable_events=True, tooltip=tooltip)]

# todo: validate input for ints (including negative in some cases)
def qinput(cfg_data, section, key, size=(100, None)):
  name, wkey= name_wkey(cfg_data, section, key)
  return [sg.Text("       " + name), sg.InputText("", key=wkey, size=size, enable_events=True)]

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
  window[key](text_color='gray') # doesn't work in some items, for example dropdown. Works for spin.
  window[key](disabled=True)
  if new_value is not None:
    window[key](value=new_value)
  else:
    window[key](value=old_value)
