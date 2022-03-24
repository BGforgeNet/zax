import os
import platform
import ruamel.yaml

# internal
from zax.variables import zax_yml
from zax.games import Games


class ZaxConfig:
    def __init__(self):
        self.data = self.load()
        self.games = Games(self.data["games"])
        try:
            self.theme = self.data["theme"]
        except:
            self.theme = "light"
            self.data["theme"] = "light"

    def load(self):
        yaml = ruamel.yaml.YAML(typ="rt")
        config = {"games": []}
        if os.path.isfile(zax_yml):
            try:
                with open(zax_yml) as yf:
                    config = yaml.load(yf)
            except:
                os.makedirs(self.config_dir, exist_ok=True)
        return config

    def save(self, game_path=None, wine_prefix="", wine_debug=""):
        yaml = ruamel.yaml.YAML(typ="rt")

        # clean out empty wine_debug and wine_prefix stanzas from config
        if (platform.system() != "Windows") and game_path:
            new_games = []

            for g in self.games.games:
                ng = {}
                ng["path"] = g["path"]

                if g["path"] == game_path:  # wine config for current game from window
                    if (wine_prefix != "") and (wine_prefix is not None):
                        ng["wine_prefix"] = wine_prefix
                    if (wine_debug != "") and (wine_debug is not None):
                        ng["wine_debug"] = wine_debug
                else:  # wine config for other games loaded from yml
                    if ("wine_prefix" in g) and (g["wine_prefix"] != "") and (g["wine_prefix"] is not None):
                        ng["wine_prefix"] = g["wine_prefix"]
                    if ("wine_debug" in g) and (g["wine_debug"] != "") and (g["wine_debug"] is not None):
                        ng["wine_debug"] = g["wine_debug"]
                new_games.append(ng)
            self.games.games = new_games
            self.data["games"] = self.games.games

        # sort
        new_games = [g for g in self.games.games]
        new_games = sorted(new_games, key=lambda k: k["path"])
        self.games.games = new_games
        self.data["games"] = self.games.games

        self.data["theme"] = self.theme
        os.makedirs(os.path.dirname(zax_yml), exist_ok=True)
        with open(zax_yml, "w") as yf:
            yaml.dump(self.data, yf)

    def add_game(self, path):
        self.games.add(path)
        self.data["games"] = self.games.games

    def remove_game(self, path):
        self.games.remove(path)
        self.data["games"] = self.games.games

    def scan_games(self):
        self.games.scan()
        self.data["games"] = self.games.games
