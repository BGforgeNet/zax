#!/usr/bin/env python3

from typing import OrderedDict
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys, io
import iniparse
import layout
import pprint
pp = pprint.PrettyPrinter(indent=2)


class CfgState:
  def __init__(self, game_path, config_path):
    self.ini_data = self.load_ini(game_path, config_path)
    self.ini_format = self.load_ini_format(config_path)
    self.config_path = config_path
    self.game_path = game_path
  # ini_data = {}
  # ini_format = {}
  # window_data = {}
  def load_ini(self, game_path, config_path):
    cfg = iniparse.INIConfig(io.open(os.path.join(game_path, config_path)))
    return cfg

  def load_ini_format(self, config_path):
    config = os.path.join('configs', config_path) + '.yml'
    with open(config) as yf:
      data = yaml.load(yf)
    return data

  def window_data(self):
    win_data = {}
    ini_format = self.ini_format
    ini_data = self.ini_data

    for section in ini_format:

      if section == 'f2gm':
        continue

      for key in ini_format[section]:
        win_key = "{}-{}-{}".format(self.config_path, section, key)
        try: # choice: radio / dropdown
          options = ini_format[section][key]['options']

          if ini_format[section][key]['type'] == 'radio':
            radio_value = ini_data[section][key]
            for o in options:
              # # Doesn't work. Qt automatically disables all radio in group after one of them is disabled
              # o_value = False
              # if int(o['value']) == int(radio_value):
              #   o_value = True
              # win_data["{}-{}-{}-{}".format(self.config_path, section, key, o['value'])] = o_value
              # # So we are adding only enabled option to data map
              if int(o['value']) == int(radio_value):
                win_data["{}-{}-{}-{}".format(self.config_path, section, key, o['value'])] = True

          elif ini_format[section][key]['type'] == 'dropdown':
            dd_value = int(ini_data[section][key])
            dd_win_value = [x['name'] for x in options if x['value'] == dd_value][0]
            win_data[win_key] = dd_win_value

          else:
            print("strange choice {}:{} in {} - not dropdown, nor radio".format(section, key, self.config_path))
        except:
          try: # typed: float, string, int
            dtype = ini_format[section][key]['type']
            if dtype == 'float':
              value = ini_data[section][key]
              value = int(float(value) * ini_format[section][key]['float_base'])
              win_data[win_key] = value
            elif dtype == 'string':
              win_data[win_key] = ini_data[section][key]
            elif dtype == 'int':
              win_data[win_key] = int(ini_data[section][key])
            else: # bool
              print("can't find value type for {}:{} in {}".format(section, key, self.config_path))
          except:
            try: # bool
              if int(ini_data[section][key]) == 1:
                win_data[win_key] = True
              elif int(ini_data[section][key]) == 0:
                win_data[win_key] = False
              else:
                print("can't find value type for {}:{} in {}".format(section, key, self.config_path))
            except: # keys are missing from ini
              print("can't find {}:{} in {}".format(section, key, self.config_path))

    pp.pprint(win_data)
    return(win_data)
    # sys.exit(0)
    # kvmap = {}
    # for s in cfg:
    #   for k in cfg[s]:
    #     wkey = "{}-{}-{}".format(ini, s, k)
    #     kvmap[wkey] = cfg[s][k]
    # return kvmap
    # self.window_data = {}
