from typing import OrderedDict
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys, io
import iniparse
import layout
import pprint
pp = pprint.PrettyPrinter(indent=2)

def get_ini_format(f):
  with open(f) as yf:
    data = yaml.load(yf)
  return data

def get_ini_formats():
  format_dir = 'formats'
  format_files = [os.path.join(format_dir, f) for f in os.listdir(format_dir) if os.path.isfile(os.path.join(format_dir, f)) and f.lower().endswith('.yml')]
  format_files.sort()
  formats = OrderedDict()
  for f in format_files:
    data = get_ini_format(f)
    path = data['f2gm']['path']
    formats[path] = data
  return formats
ini_formats = get_ini_formats()

class ValueMap:

  def __init__(self) -> None:
    ini_formats = get_ini_formats()
    valuemap = {}
    for ini_path in ini_formats:
      valuemap = {**valuemap, **self.generate_ini2window(ini_formats[ini_path])}
    self.map = valuemap

  def generate_ini2window(self, ini_format):
    ini2window = {}
    path = ini_format['f2gm']['path']
    for section in ini_format:
      if section == 'f2gm':
        continue
      for key in ini_format[section]:
        win_key = "{}-{}-{}".format(path, section, key)
        try: # choice: radio / dropdown
          options = ini_format[section][key]['options']
          if ini_format[section][key]['display_type'] == 'radio':
            for o in options:
              # # Qt automatically disables all radio in group after one of them is disabled
              # # https://github.com/PySimpleGUI/PySimpleGUI/issues/4639
              # # So we are adding only one, enabled option to data map
              win_key = "{}-{}-{}-{}".format(path, section, key, o['value'])
              ini2window[win_key] = {}
              ini2window[win_key][str(o['value'])] = True
          elif ini_format[section][key]['display_type'] == 'dropdown':
            ini2window[win_key] = {}
            for o in options:
              ini2window[win_key][str(o['value'])] = o['name']
          else:
            print("Error: strange choice {}:{} in {} - not dropdown, nor radio".format(section, key, path))
        except:
          try:
            data_type = ini_format[section][key]['type']
          except:
            ini2window[win_key] = {}
            ini2window[win_key]['0'] = False
            ini2window[win_key]['1'] = True
    return ini2window
value_map = ValueMap().map


class Config:
  def __init__(self, game_path, config_path):
    self.ini_data = self.load_ini(game_path, config_path)
    self.ini_format = ini_formats[config_path]
    self.config_path = config_path
    self.game_path = game_path

  def load_ini(self, game_path, config_path):
    cfg = iniparse.INIConfig(io.open(os.path.join(game_path, config_path)))
    return cfg

  def get_win_key(self, section, key, value):
    win_key = "{}-{}-{}".format(self.config_path, section, key)
    try: # choice: radio
      options = self.ini_format[section][key]['options']
      if self.ini_format[section][key]['display_type'] == 'radio':
        for o in options:
          if str(o['value']) == value:
            win_key = "{}-{}-{}-{}".format(self.config_path, section, key, o['value'])
    except:
      pass
    return win_key

  def window_data(self):
    win_data = {}
    ini_format = self.ini_format
    ini_data = self.ini_data
    for section in self.ini_format:
      if section == 'f2gm':
        continue

      for key in ini_format[section]:
        ini_value = ini_data[section][key]
        win_key = self.get_win_key(section, key, ini_value)
        try:
          win_data[win_key] = value_map[win_key][ini_value]
        except:
          if type(ini_value)  == iniparse.config.Undefined:
            print("key {} not found in {}".format(key, self.config_path))
          else:
            try: # typed: float, string, int
              data_type = ini_format[section][key]['type']
              if data_type == 'float':
                value = int(float(ini_value) * ini_format[section][key]['float_base'])
                win_data[win_key] = value
              elif data_type == 'string':
                win_data[win_key] = ini_value
              elif data_type == 'int':
                win_data[win_key] = int(ini_value)
            except:
              print("Error: can't find value type for {}:{} in {}".format(section, key, self.config_path))
    return win_data
