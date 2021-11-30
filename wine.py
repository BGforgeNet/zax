import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
from zax_log import log

def save(zax_yml, config, games, game_path, values):
  new_games = []
  for g in games:
    if g['path'] == game_path:
      g['wine_prefix'] = values['wine_prefix']
      g['wine_debug'] = values['wine_debug']
    new_games.append(g)
  config['games'] = new_games
  with open(zax_yml, 'w') as yf:
    yaml.dump(config, yf)

def load(games, game_path, window):
  log('loading wine')
  for g in games:
    if g['path'] == game_path:
      try:
        window['wine_prefix'](value=g['wine_prefix'])
      except:
        window['wine_prefix'](value='')
      try:
        window['wine_debug'](value=g['wine_debug'])
      except:
        window['wine_debug'](value='')
      break
