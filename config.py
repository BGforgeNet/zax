from typing import OrderedDict
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, io
import iniparse
from zax_log import log

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
    path = data['zax']['path']
    formats[path] = data
  return formats
ini_formats = get_ini_formats()

key2dx = {
  "1": '2',
  "2": '3',
  "3": '4',
  "4": '5',
  "5": '6',
  "6": '7',
  "7": '8',
  "8": '9',
  "9": '10',
  # "0": 11, # 0 means disabled key
  "-": '12', # on main keyboard
  "=": '13',
  "Q": '16',
  "W": '17',
  "E": '18',
  "R": '19',
  "T": '20',
  "Y": '21',
  "U": '22',
  "I": '23',
  "O": '24',
  "P": '25',
  "A": '30',
  "S": '31',
  "D": '32',
  "F": '33',
  "G": '34',
  "H": '35',
  "J": '36',
  "K": '37',
  "L": '38',
  ";": '39',
  "'": '40',
  "`": '41', # accent grave
  "\\": '43',
  "Z": '44',
  "X": '45',
  "C": '46',
  "V": '47',
  "B": '48',
  "N": '49',
  "M": '50',
  ",": '51',
  ".": '52', # on main keyboard
  "/": '53', # on main keyboard
}
dx2key = {}
for k in key2dx:
  dx2key[key2dx[k]] = k

class ValueMap:

  def __init__(self) -> None:
    ini_formats = get_ini_formats()
    valuemap = {}
    winmap = {}
    for ini_path in ini_formats:
      valuemap = {**valuemap, **self.generate_ini2window(ini_formats[ini_path])}
      winmap = {**winmap, **self.generate_window2ini(ini_formats[ini_path])}
    self.i2w = valuemap
    self.w2i = winmap

  def generate_ini2window(self, ini_format):
    ini2window = {}
    path = ini_format['zax']['path']
    for section in ini_format:
      if section == 'zax':
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
            log("Error: strange choice {}:{} in {} - not dropdown, nor radio".format(section, key, path))
        except:
          try:
            data_type = ini_format[section][key]['type']
            if data_type == 'dx_key':
              ini2window[win_key] = {}
              for dx in dx2key:
                ini2window[win_key][str(dx)] = dx2key[dx]
              ini2window[win_key]['0'] = '0'
          except:
            ini2window[win_key] = {}
            ini2window[win_key]['0'] = False
            ini2window[win_key]['1'] = True
    return ini2window

  def generate_window2ini(self, ini_format):
    window2ini = {}
    path = ini_format['zax']['path']
    for section in ini_format:
      if section == 'zax':
        continue
      for key in ini_format[section]:
        win_key = "{}-{}-{}".format(path, section, key)
        try: # choice: radio / dropdown
          options = ini_format[section][key]['options']
          if ini_format[section][key]['display_type'] == 'radio':
            for o in options:
              win_key = "{}-{}-{}-{}".format(path, section, key, o['value'])
              window2ini[win_key] = { 'path': path, 'section': section, 'key': key, 'values': {True: o['value']}, 'display_type': 'radio'}
          elif ini_format[section][key]['display_type'] == 'dropdown':
            values = {o['name']: o['value'] for o in options}
            window2ini[win_key] = {'path': path, 'section': section, 'key': key, 'values': values}
          else:
            log("Error: strange choice {}:{} in {} - not dropdown, nor radio".format(section, key, path))
        except:
          try: # float
            window2ini[win_key] = {'path': path, 'section': section, 'key': key, 'type': 'float', 'float_base': ini_format[section][key]['float_base']}
          except:
            try: # dx_key
              window2ini[win_key] = {'path': path, 'section': section, 'key': key, 'type': ini_format[section][key]['type']}
            except: # default
              window2ini[win_key] = {'path': path, 'section': section, 'key': key}
    return window2ini

vmap = ValueMap()
i2w = vmap.i2w
w2i = vmap.w2i

class Config:
  def __init__(self, game_path, config_path):
    self.ini_data = self.load_ini(game_path, config_path)
    self.ini_format = ini_formats[config_path]
    self.config_path = config_path
    self.game_path = game_path

  def load_ini(self, game_path, config_path):
    with open(os.path.join(game_path, config_path)) as fh:
      cfg = iniparse.INIConfig(fh)
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
      if section == 'zax':
        continue

      for key in ini_format[section]:
        try:
          ini_value = ini_data[section][key]
          win_key = self.get_win_key(section, key, ini_value)
          win_data[win_key] = i2w[win_key][ini_value]
        except:
          if type(ini_value)  == iniparse.config.Undefined:
            log("key {}:{} not found in {}".format(section, key, self.config_path))
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
              log("Error: can't find value type for {}:{} in {}".format(section, key, self.config_path))
    return win_data

  def save(self, new_data):
    path = os.path.join(self.game_path, self.config_path)
    with io.open(path, 'w') as fh:
      cfg = self.ini_data
      for section in new_data:
        for key in new_data[section]:
          if cfg[section][key] != new_data[section][key]:
            log("{} change from {} to {}".format(key, cfg[section][key], new_data[section][key]))
          cfg[section][key] = new_data[section][key]
      content = str(cfg)
      content = content.replace('\n', '\r\n')
      fh.write(content)

def winkey2ini(win_key, win_value):
  ini_key = {'path': w2i[win_key]['path'], 'section': w2i[win_key]['section'], 'key': w2i[win_key]['key']}
  try:
    value = w2i[win_key]['values'][win_value] # radio, dropdown
  except:
    # radio off options
    if 'display_type' in w2i[win_key] and w2i[win_key]['display_type'] == 'radio' and win_value == False:
      return None

    if 'type' in w2i[win_key] and w2i[win_key]['type'] == 'dx_key':
      ini_key['value'] = key2dx[win_value]
      return ini_key

    try: # float
      float_base = w2i[win_key]['float_base'] # float
      value = win_value / float_base
      precision = len(str(float_base)) - len(str(float_base).rstrip('0'))
      value = '{:.{precision}f}'.format(value, precision=precision)
    except:
      if win_value is True: # bool/radio
        value = 1
      elif win_value is False:
        value = 0
      else:
        value = win_value
  value = str(value)
  ini_key['value'] = value
  return ini_key

class GameConfig():
  def __init__(self, game_path):
    self.game_path = game_path
    self.config_formats = self.get_config_formats()
    self.config_paths = self.get_config_paths()
    self.configs = self.init_configs()

  def get_config_formats(self):
    config_dir = 'formats'
    config_files = [os.path.join(config_dir, f) for f in os.listdir(config_dir) if os.path.isfile(os.path.join(config_dir, f)) and f.lower().endswith('.yml')]
    config_files.sort()
    configs = OrderedDict()
    for f in config_files:
      with open(f) as yf:
        data = yaml.load(yf)
      path = data['zax']['path']
      configs[path] = data
    return configs

  def init_configs(self):
    formats = self.config_formats
    configs = {}
    for c in formats:
      path = formats[c]['zax']['path']
      cfg = Config(self.game_path, formats[c]['zax']['path'])
      configs[path] = cfg
    return configs

  def load_from_disk(self, window, values):
    for c in self.configs:
      new_values = self.configs[c].window_data()
      for key in new_values:
        if key in values:
          window[key](new_values[key])
        else:
          log("warning: key {} not found in window".format(key))

  def get_config_paths(self):
    configs = self.config_formats
    paths = [x for x in configs]
    return paths

  def save(self, values):
    new_ini_data = {}
    for wk in values:
      try:
        ik = winkey2ini(wk, values[wk])
        path = ik['path']
        section = ik['section']
        key = ik['key']
        if not path in new_ini_data:
          new_ini_data[path] = {}
        if not section in new_ini_data[path]:
          new_ini_data[path][section] = {}
        new_ini_data[path][section][key] = ik['value']
      except:
        log("can't get ini key for {}".format(wk))
        pass
    for c in new_ini_data:
      self.configs[c].save(new_ini_data[c])
