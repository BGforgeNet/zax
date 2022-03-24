import importlib.resources
from base64 import b64encode


class Resources:
    def __init__(self):
        self.game_icons = self._read_game_icons()
        self.ini_formats = self._read_ini_formats()

    def _read_game_icons(self):
        game_icons = {}
        for i in ["fallout2", "fallout2rpu", "fallout2upu"]:
            bin = importlib.resources.read_binary("zax.icons", "{}.png".format(i))
            bin64 = b64encode(bin)  # treedata needs base64 encoded icons
            game_icons[i] = bin64
        return game_icons

    def _read_ini_formats(self):
        ini_formats = {}
        for i in ["ddraw.ini", "f2_res.ini", "fallout2.cfg"]:
            text = importlib.resources.read_text("zax.formats", "{}.yml".format(i))
            ini_formats[i] = text
        return ini_formats


RESOURCES = Resources()
