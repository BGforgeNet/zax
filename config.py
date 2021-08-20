from typing import OrderedDict
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys, io
import iniparse
import layout
import pprint
pp = pprint.PrettyPrinter(indent=2)


class ValueMap:

  def __init__(self) -> None:
    ini_formats = self.get_ini_formats()
    valuemap = {}
    for ini_path in ini_formats:
      valuemap = {**valuemap, **self.generate_ini2window(ini_formats[ini_path])}
    self.valuemap = valuemap

  def get_ini_formats(self):
    format_dir = 'formats'
    format_files = [os.path.join(format_dir, f) for f in os.listdir(format_dir) if os.path.isfile(os.path.join(format_dir, f)) and f.lower().endswith('.yml')]
    format_files.sort()
    formats = OrderedDict()
    for f in format_files:
      with open(f) as yf:
        data = yaml.load(yf)
      path = data['f2gm']['path']
      formats[path] = data
    return formats

  def generate_ini2window(self, ini_format):
    ini2window = {}
    path = ini_format['f2gm']['path']
    for section in ini_format:
      print(section)
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
              win_key = "{}-{}-{}-{}".format(path, section, key, o['name'])
              ini2window[win_key] = True
          elif ini_format[section][key]['display_type'] == 'dropdown':
            ini2window[win_key] = {}
            for o in options:
              ini2window[win_key][o['value']] = o['name']
          else:
            print("Error: strange choice {}:{} in {} - not dropdown, nor radio".format(section, key, path))
        except:
          ini2window[win_key] = {}
          ini2window[win_key][0] = False
          ini2window[win_key][1] = True
    return ini2window
    # pp.pprint(ini2window)


        # except:
        #   pass
        # print(win_key)
    #       try: # typed: float, string, int
    #         dtype = ini_format[section][key]['type']
    #         if dtype == 'float':
    #           value = ini_data[section][key]
    #           value = int(float(value) * ini_format[section][key]['float_base'])
    #           win_data[win_key] = value
    #         elif dtype == 'string':
    #           win_data[win_key] = ini_data[section][key]
    #         elif dtype == 'int':
    #           win_data[win_key] = int(ini_data[section][key])
    #         else: # unknown type
    #           print("Error: can't find value type for {}:{} in {}".format(section, key, self.config_path))
    #       except:
    #         try: # bool
    #           if int(ini_data[section][key]) == 1:
    #             win_data[win_key] = True
    #           elif int(ini_data[section][key]) == 0:
    #             win_data[win_key] = False
    #           else:
    #             print("Error: can't convert untyped value {}:{} to bool in {}".format(section, key, self.config_path))
    #         except: # keys are missing from ini
    #           print("Warning: can't find {}:{} in {}".format(section, key, self.config_path))

    # return(win_data)


class CfgState:
  def __init__(self, game_path, config_path):
    self.ini_data = self.load_ini(game_path, config_path)
    self.ini_format = self.load_ini_format(config_path)
    self.config_path = config_path
    self.game_path = game_path

  def load_ini(self, game_path, config_path):
    cfg = iniparse.INIConfig(io.open(os.path.join(game_path, config_path)))
    return cfg

  def load_ini_format(self, config_path):
    config = os.path.join('formats', config_path) + '.yml'
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

          if ini_format[section][key]['display_type'] == 'radio':
            radio_value = ini_data[section][key]
            for o in options:
              # # Doesn't work. Qt automatically disables all radio in group after one of them is disabled
              # # https://github.com/PySimpleGUI/PySimpleGUI/issues/4639
              # o_value = False
              # if int(o['value']) == int(radio_value):
              #   o_value = True
              # win_data["{}-{}-{}-{}".format(self.config_path, section, key, o['value'])] = o_value
              # # So we are adding only one, enabled option to data map
              if int(o['value']) == int(radio_value):
                win_data["{}-{}-{}-{}".format(self.config_path, section, key, o['value'])] = True

          elif ini_format[section][key]['display_type'] == 'dropdown':
            dd_value = int(ini_data[section][key])
            dd_win_value = [x['name'] for x in options if x['value'] == dd_value][0]
            win_data[win_key] = dd_win_value

          else:
            print("Error: strange choice {}:{} in {} - not dropdown, nor radio".format(section, key, self.config_path))
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
            else: # unknown type
              print("Error: can't find value type for {}:{} in {}".format(section, key, self.config_path))
          except:
            try: # bool
              if int(ini_data[section][key]) == 1:
                win_data[win_key] = True
              elif int(ini_data[section][key]) == 0:
                win_data[win_key] = False
              else:
                print("Error: can't convert untyped value {}:{} to bool in {}".format(section, key, self.config_path))
            except: # keys are missing from ini
              print("Warning: can't find {}:{} in {}".format(section, key, self.config_path))

    return(win_data)
