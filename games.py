import os
from pathlib import Path
import platform
from common import resource_path
from theme import sg
from zax_log import log


class Games:
    def __init__(self, games_config):
        self.games = []
        for g in games_config:  # [{'path': path},] from zax.yml
            g["type"] = self.game_type(g["path"])
            self.games.append(g)
        self.paths = self.get_paths()
        self.paths_with_icons = self._games_with_icons()

    def get_paths(self):
        paths = [g["path"] for g in self.games]
        paths = sorted(list(set(paths)))
        return paths

    def _games_with_icons(self):
        icons_dir = resource_path("icons")
        values = []
        for g in self.games:
            values.append([g["path"], os.path.join(icons_dir, "{}.png".format(g["type"]))])
        return values

    def get_wine_config(self, path):
        if platform.system == "Windows":
            return None
        wcfg = {"wine_debug": "", "wine_prefix": ""}
        game = [g for g in self.games if g["path"] == path][0]
        if "wine_debug" in game:
            wcfg["wine_debug"] = game["wine_debug"]
        if "wine_prefix" in game:
            wcfg["wine_prefix"] = game["wine_prefix"]
        return wcfg

    def add(self, path):
        if path is None:  # nothing entered in popup
            return False
        if not os.path.isdir(path):
            sg.popup("{} is not a directory!".format(path))
            return False
        type = self.game_type(path)
        if type is not None:
            if path in self.paths:
                sg.popup("This game is already on the list!")
            else:
                self.games.append({"path": path, "type": type})
        self.paths = self.get_paths()
        self.paths_with_icons = self._games_with_icons()

    def remove(self, path):
        self.games = [g for g in self.games if g["path"] != path]
        self.paths = self.get_paths()
        self.paths_with_icons = self._games_with_icons()

    def game_type(self, path):
        files = [f.lower() for f in os.listdir(path) if os.path.isfile(os.path.join(path, f))]
        if "fallout2.exe" in files:
            if os.path.exists(os.path.join(path, "mods", "rpu.dat")):
                return "fallout2rpu"
            if os.path.exists(os.path.join(path, "mods", "upu.dat")):
                return "fallout2upu"
            return "fallout2"
        return None

    def scan(self):
        DIR_LIST = []
        REL_DIR_LIST = [
            "GOG Games/Fallout 2",
            "Games/Fallout 2",
            "Games/Fallout2",
            "Program Files (x86)/Steam/steamapps/common/Fallout 2",
        ]

        if platform.system == "Windows":
            for disk in ["C:", "D:"]:
                for rd in REL_DIR_LIST:
                    path = str(Path.resolve(disk + "/" + rd))
                    DIR_LIST.append(path)
        else:
            home = str(Path.home())
            for rd in REL_DIR_LIST:
                DIR_LIST.append(str(Path("{}/.wine/drive_c/{}".format(home, rd)).resolve()))
                DIR_LIST.append(str(Path("{}/.wine/drive_c/{}".format(home, rd.lower())).resolve()))

        for d in DIR_LIST:
            if os.path.isdir(d) and self.game_type(d) and d not in self.paths:
                log("found game: {}".format(d))
                self.games.append({"path": d})
        self.paths = self.get_paths()
        self.paths_with_icons = self._games_with_icons()
