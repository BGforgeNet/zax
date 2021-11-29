import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")

def save(zax_yml, config, games, game_path, values):
  new_games = []
  for g in games:
    if g['path'] == game_path:
      g['wine_prefix'] = values['wine_prefix']
      g['wine_args'] = values['wine_args']
    new_games.append(g)
  config['games'] = new_games
  with open(zax_yml, 'w') as yf:
    yaml.dump(config, yf)

def load(games, game_path, window):
  print('loading wine')
  for g in games:
    if g['path'] == game_path:
      try:
        window['wine_prefix'](value=g['wine_prefix'])
      except:
        window['wine_prefix'](value='')
      try:
        window['wine_args'](value=g['wine_args'])
      except:
        window['wine_args'](value='')
      break
