from datetime import datetime
import platform
import subprocess
import PySimpleGUIQt as sg

from .common import disable_element, enable_element, frame
from variables import debug_dir, tmp_dir
import os
from zipfile import ZIP_DEFLATED, ZipFile
from common import cd
from zax_log import log

layout = [
    [sg.Text("This tab contains shortcuts for resolving various common issues,", justification="c")],
    [sg.Text(" and allows you to prepare an archive with information needed in bug reports.", justification="c")],
    frame(
        "Bug report",
        [
            [
                sg.Text("Step 1: enable debug."),
                sg.Button("Enable", key="btn_trouble_enable_debug", size=(150, None)),
            ],
            [sg.Text("Step 2: launch the game and reproduce the issue. Exit game.")],
            [
                sg.Text("Step 3: create debug package"),
                sg.Button(
                    "Create",
                    tooltip="Prepare an archive with all relevant configs and mod versions",
                    key="btn_trouble_package_debug",
                    size=(150, None),
                ),
            ],
        ],
    ),
]


def handle_event(window: sg.Window, event: str, values, game_config, game_path=None):
    debug_keys = [
        "ddraw.ini-Debugging-Init",
        "ddraw.ini-Debugging-Hook",
        "ddraw.ini-Debugging-Script",
        "ddraw.ini-Debugging-Criticals",
        "ddraw.ini-Debugging-Fixes",
        "fallout2.cfg-debug-output_map_data_info",
        "fallout2.cfg-debug-show_load_info",
        "fallout2.cfg-debug-show_script_messages",
        "fallout2.cfg-debug-show_tile_num",
        "fallout2.cfg-sound-debug",
        "fallout2.cfg-sound-debug_sfxc",
    ]

    if event == "tg_main" or event == "configs_loaded":
        debug_all_enabled = True
        for k in debug_keys:
            if values[k] is not True:
                debug_all_enabled = False
                break
        if debug_all_enabled and values["ddraw.ini-Debugging-DebugMode"] == "debug.log":
            disable_element("btn_trouble_enable_debug", window)
            window["btn_trouble_enable_debug"](text="Already enabled")
        else:
            enable_element("btn_trouble_enable_debug", window)
            window["btn_trouble_enable_debug"](text="Enable")

    if event == "btn_trouble_enable_debug":
        window["ddraw.ini-Debugging-DebugMode"]("debug.log")
        values["ddraw.ini-Debugging-DebugMode"] = "debug.log"  # setting separately because this button saves config too
        for k in debug_keys:
            window[k](True)
            values[k] = True
        disable_element("btn_trouble_enable_debug", window)
        window["btn_trouble_enable_debug"](text="Already enabled")
        game_config.save(values)

    if event == "btn_trouble_package_debug":
        with cd(game_path):
            timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
            zip_path = os.path.join(debug_dir, "zax_debug_{}.zip".format(timestamp))
            with ZipFile(zip_path, "w", ZIP_DEFLATED) as zip_h:
                for f in os.listdir("."):
                    if (
                        f.lower().endswith(".ini")
                        or f.lower().endswith(".cfg")
                        or f.lower() == "ddraw.dll"
                        or f.lower() == "debug.log"
                        or f.lower() == "sfall-log.txt"
                    ):
                        zip_h.write(f, f)
                maindir_list = os.path.join(tmp_dir, "game.txt")
                with open(maindir_list, "w") as fh:
                    content = '\n'.join(sorted(os.listdir(game_path)))
                    fh.write(content)
                zip_h.write(maindir_list, "game.txt")
                if os.path.isdir("mods"):
                    for f in os.listdir("mods"):
                        if f.lower().endswith(".ini"):
                            fpath = os.path.join("mods", f)
                            zip_h.write(fpath, fpath)
                    mods_list = os.path.join(tmp_dir, "mods.txt")
                    with open(mods_list, "w") as fh:
                        content = '\n'.join(sorted(os.listdir("mods")))
                        fh.write(content)
                    zip_h.write(mods_list, "mods.txt")
        if platform.system() == "Windows":
            subprocess.Popen(["explorer", "/select", zip_path])
        else:
            subprocess.Popen(["xdg-open", debug_dir])
        log("debug archive created")
