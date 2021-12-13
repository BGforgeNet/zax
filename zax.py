#!/usr/bin/env python3

import subprocess
import sys
from theme import sg
import os
from PySimpleGUIQt.PySimpleGUIQt import SELECT_MODE_SINGLE
import layout
from config import GameConfig
import sfall
import updates
import queue
import platform
import shutil
from packaging import version
from zax_log import log, logger
from variables import backup_dir, log_file, debug_dir
from version import VERSION
from layouts.zax import zax_layout
from games import Games
from zax_config import ZaxConfig
import ruamel.yaml
import image_listbox as ilb

yaml = ruamel.yaml.YAML(typ="rt")

# splash only working when compiled
splash = False
try:
    import pyi_splash  # type: ignore

    splash = True
except:
    log("can't import pyi_splash, not compiled by pyinstaller")


def handle_zax_tab(event, values, zax_config):
    if event == "zax-backup-open":
        if platform.system() == "Windows":
            subprocess.Popen(["explorer", backup_dir])
        else:
            subprocess.Popen(["xdg-open", backup_dir])
    if event == "zax-backup-wipe":
        shutil.rmtree(backup_dir)
        os.makedirs(backup_dir, exist_ok=True)

    if event == "zax-debug-open":
        if platform.system() == "Windows":
            subprocess.Popen(["explorer", debug_dir])
        else:
            subprocess.Popen(["xdg-open", debug_dir])
    if event == "zax-debug-wipe":
        shutil.rmtree(debug_dir)
        os.makedirs(debug_dir, exist_ok=True)

    if event == "zax-log-view":
        if platform.system() == "Windows":
            subprocess.Popen(["explorer", "/select", log_file])
        else:
            subprocess.Popen(["xdg-open", log_file])

    if event == "btn_zax_theme_restart":
        zax_config.theme = values["dd_zax_theme"]
        zax_config.save()
        # os.execl(sys.executable, '"{}"'.format(sys.executable), *sys.argv)
        os.execl(sys.executable, os.path.abspath(__file__), *sys.argv)


def handle_event(
    window: sg.Window, event, values: dict, game_path: str, game_config: GameConfig, games: Games, zax_config
):
    if event.startswith("zax-") or event == "btn_zax_theme_restart":
        handle_zax_tab(event, values, zax_config)

    if event == "listbox_games" or event == "btn_sfall_update":
        window["configs_loaded"](False)
        game_config = GameConfig(game_path)
        game_config.load_from_disk(window, values, games, game_path)

    config_paths = game_config.config_paths
    for p in config_paths:
        layout.handle_custom_event(p, window, event, values)

    # this must go last, so that ui is updated properly on game switch
    if (
        event == "btn_trouble_enable_debug"
        or event == "tg_main"
        or event == "configs_loaded"
        or event == "btn_trouble_package_debug"
    ):
        layout.handle_non_config_event("trouble", window, event, values, game_config, game_path)

    if event == "listbox_games":
        window["configs_loaded"](True)

    return game_config


def launch_game(path, wine_prefix="", wine_debug="", sfall_version=None):
    try:
        subprocess.CREATE_NEW_PROCESS_GROUP
    except AttributeError:
        my_env = os.environ.copy()
        if wine_prefix != "":
            my_env["WINEPREFIX"] = wine_prefix
        if wine_debug != "":
            my_env["WINEDEBUG"] = wine_debug
        if version.parse(sfall_version) < version.parse("4.1.2"):
            my_env["WINEDLLOVERRIDES"] = "ddraw.dll=n"
        else:
            my_env["WINEDLLOVERRIDES"] = "ddraw.dll=n,b"
        # not Windows, so assume POSIX; if not, we'll get a usable exception
        args = ["wine", "fallout2.exe"]
        subprocess.Popen(args, cwd=path, start_new_session=True, env=my_env)
    else:
        # Windows
        args = "fallout2.exe"
        subprocess.Popen(args, cwd=path, creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)


def scan(games, window):
    games.scan()
    if len(games.paths) > 0:
        window["listbox_games"](values=games.paths)
        window["listbox_games"](set_to_index=0)
    log("finished scanning")


@logger.catch
def __main__(splash=False):
    if splash:
        pyi_splash.update_text("Furiously loading...")

    gui_queue = queue.Queue()  # queue used to communicate between the gui and the threads

    sfall_latest_version = None
    sfall.launch_latest_check(gui_queue)
    sfall_current = None
    zax_latest_version = None
    updates.launch_latest_check(gui_queue)
    game_config = None
    zax_config = ZaxConfig()
    games = zax_config.games
    game_path = None

    wine_visible = False
    if platform.system() != "Windows":
        wine_visible = True

    settings_tabs = [
        sg.Tab("Game", [[layout.layout["fallout2.cfg"]]], key="tab-fallout2.cfg"),
        sg.Tab("HiRes", [[layout.layout["f2_res.ini"]]], key="tab-f2_res.ini"),
        sg.Tab("Sfall", [[layout.layout["ddraw.ini"]]], key="tab-ddraw.ini"),
        sg.Tab("Wine", layout.layout["wine"], key="tab-wine", visible=wine_visible),
    ]

    settings_layout = [
        [sg.TabGroup([settings_tabs], enable_events=True, key="tab-settings-sub")],
        [sg.Button("Save", key="save")],
        [sg.Button("Play", key="play")],
        # checkbox is a hack for triggering event to disable elements after config loading
        [
            sg.Checkbox(
                "configs_loaded",
                key="configs_loaded",
                enable_events=True,
                visible=False,
            )
        ],
    ]
    games_ilb = ilb.ImageListBox(
        [g["path"] for g in games.games],
        headings=["tree_games"],
        num_rows=10,
        size=(24 * 9, 10 * 10),
        pad=((12, 5), (10, 10)),
        # size=(23, 17),
        select_mode=ilb.SELECT_MODE_SINGLE,
        enable_events=True,
        key="tree_games",
        default_icon=ilb.icon_folder
    )

    games_layout = [
        [games_ilb.element],
        [
            sg.Listbox(
                values=games.paths,
                size=(23, 17),
                key="listbox_games",
                enable_events=True,
                select_mode=SELECT_MODE_SINGLE,
                pad=((12, 5), (10, 10)),  # ((left, right), (top, bottom)) - for some reason it's skewed to the left
                visible=False
            )
        ],
        [sg.Button("Add game", key="add-game")],
        [sg.Button("Remove from list", key="remove-game")],
    ]

    left_col = [[sg.TabGroup([[sg.Tab("Games", games_layout), sg.Tab("ZAX", zax_layout)]])]]
    right_col = [
        [
            sg.TabGroup(
                [
                    [
                        sg.Tab("Settings", settings_layout),
                        sg.Tab("Troubleshooting", layout.layout["trouble"]),
                    ]
                ],
                key="tg_main",
                enable_events=True,
            )
        ]
    ]

    main_layout = [
        [
            sg.Column(left_col, element_justification="c"),
            sg.VSeperator(),
            sg.Column(right_col, size=(500, 500)),
        ]
    ]

    if splash:
        pyi_splash.close()
    window = sg.Window("ZAX", main_layout, finalize=True)

    try:
        window["listbox_games"](set_to_index=0)
        event, values = window.read()
        game_path = values["listbox_games"][0]
        game_config = GameConfig(game_path)
        game_config.load_from_disk(window, values, games, game_path)
        log("found games!")
    except:
        scan(games, window)

    games_ilb.init_finalize(select_first=True)

    window["dd_zax_theme"](zax_config.theme)

    # this hack allows to trigger ui updates after game list changes
    window["configs_loaded"](False)

    while True:  # Main event Loop

        event, values = window.read()

        log("event = {}".format(event))
        if event in values:
            log("value = {}".format(values[event]))
            if event == "tree_games":
                log(games_ilb.value(values))
            # if type(window[event]) is sg.Tree:
            #     log(sg.obj_to_string(window[event]))

        if event == "listbox_games" and values["listbox_games"]:
            game_path = values["listbox_games"][0]
            sfall_current = sfall.get_current(game_path)
            sfall.handle_ui_update(window, sfall_current, sfall_latest_version)

        if event == sg.WIN_CLOSED:
            break

        if event == "btn_zax_scan":
            scan(games, window)
            continue

        if event == "add-game":
            dir_path = sg.popup_get_folder("Enter game path")
            if dir_path:  # if a dir is selected
                zax_config.add_game(dir_path)
                window["listbox_games"](values=games.paths)
                new_game_index = games.paths.index(dir_path)
                window["listbox_games"](set_to_index=new_game_index)

                games_ilb.update(values=games.paths)
                games_ilb.select(dir_path)
                continue

        if game_path is not None:
            if event == "save":
                game_config.save(values)
                zax_config.save(game_path, wine_prefix=values["wine_prefix"], wine_debug=values["wine_debug"])

            if event == "play":
                launch_game(
                    game_path,
                    wine_prefix=values["wine_prefix"],
                    wine_debug=values["wine_debug"],
                    sfall_version=sfall_current,
                )
                continue

            if event == "remove-game":
                zax_config.remove_game(game_path)
                window["listbox_games"](values=games.paths)
                if len(games.paths) > 0:
                    window["listbox_games"](set_to_index=0)
                    game_path = games.paths[0]
                else:
                    game_path = None
                    game_config = None
                continue

            # background process handling
            try:
                message = gui_queue.get_nowait()
            except queue.Empty:  # get_nowait() will get exception when Queue is empty
                message = None  # break from the loop if no more messages are queued up
            if message:  # if message received from queue, display the message in the Window
                log("Got a message back from the thread: {}".format(message))
                if message["type"] == "sfall_latest":
                    sfall_latest_data = message["value"]
                    sfall_latest_version = sfall_latest_data["ver"]
                    sfall.handle_ui_update(window, sfall_current, sfall_latest_version)
                if message["type"] == "zax_latest":
                    zax_latest_data = message["value"]
                    zax_latest_version = zax_latest_data["ver"]
                    updates.handle_ui_update(window, VERSION, zax_latest_version)

            if event == "btn_sfall_update":
                sfall.update(window, sfall_latest_data, game_path)
            if event == "btn_zax_update":
                updates.update(zax_latest_data)

            game_config = handle_event(window, event, values, game_path, game_config, games, zax_config)

    zax_config.save()
    window.close()


__main__(splash=splash)
