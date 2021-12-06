import os
import platform
from pathlib import Path
from zax_log import log


# returns game list [{"path": dir}] as in zax.yml
def games(old_games=None):
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

    if old_games:
        game_list = old_games
    else:
        game_list = []
    for d in DIR_LIST:
        if os.path.isdir(d) and is_f2_game(d):
            log("found game: {}".format(d))
            game_list.append({"path": d})
    return game_list


def is_f2_game(path: str):
    if path is not None:
        if os.path.isdir(path):
            files = [f.lower() for f in os.listdir(path) if os.path.isfile(os.path.join(path, f))]
            if "fallout2.exe" in files:
                return True
    return False
