#!/usr/bin/env python3

import subprocess
import PySimpleGUIQt as sg
import os
from PySimpleGUIQt.PySimpleGUIQt import SELECT_MODE_SINGLE
import layout
from config import GameConfig
import sfall
import updates
import queue
import platform
import wine
import shutil
from packaging import version
from zax_log import log, logger
from variables import set_theme, config_dir, backup_dir, log_file
from version import VERSION
from layouts.zax import zax_layout
import ruamel.yaml

yaml = ruamel.yaml.YAML(typ="rt")

# splash only working when compiled
splash = False
try:
    import pyi_splash

    splash = True
except:
    log("can't import pyi_splash, not compiled by pyinstaller")


def get_game_paths(games):
    game_paths = [g["path"] for g in games]
    game_paths = sorted(list(set(game_paths)))
    return game_paths


def is_f2_game(path: str):
    if path is not None:
        if os.path.isdir(path):
            files = [f.lower() for f in os.listdir(path) if os.path.isfile(os.path.join(path, f))]
            if "fallout2.exe" in files:
                return True
    return False


def handle_zax_tab(event):
    if event == "zax-backup-open":
        if platform.system() == "Windows":
            subprocess.Popen(["explorer", backup_dir])
        else:
            subprocess.Popen(["xdg-open", backup_dir])
    if event == "zax-backup-wipe":
        shutil.rmtree(backup_dir)
        os.makedirs(backup_dir, exist_ok=True)
    if event == "zax-log-view":
        if platform.system() == "Windows":
            subprocess.Popen(["explorer", "/select", log_file])
        else:
            subprocess.Popen(["xdg-open", log_file])


def handle_event(window: sg.Window, event, values: dict, game_path: str, game_config):
    if event.startswith("zax-"):
        handle_zax_tab(event)

    if event == "listbox_games" or event == "btn_sfall_update":
        window["configs_loaded"](False)
        game_config = GameConfig(game_path)
        game_config.load_from_disk(window, values)

    config_paths = game_config.config_paths
    for p in config_paths:
        layout.handle_custom_event(p, window, event, values)

    # this must go last, so that ui is updated properly on game switch
    if event == "btn_trouble_enable_debug" or event == "tg_main" or event == "configs_loaded":
        layout.handle_non_config_event("trouble", window, event, values, game_config)

    if event == "listbox_games":
        window["configs_loaded"](True)

    return game_config


def launch_game(path, wine_prefix=None, wine_debug=None, sfall_version=None):
    try:
        subprocess.CREATE_NEW_PROCESS_GROUP
    except AttributeError:
        my_env = os.environ.copy()
        if wine_prefix and wine_prefix != "":
            my_env["WINEPREFIX"] = wine_prefix
        if wine_debug and wine_debug != "":
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


@logger.catch
def __main__(splash=False):
    if splash:
        pyi_splash.update_text("Furiously loading...")
    set_theme(sg)
    gui_queue = queue.Queue()  # queue used to communicate between the gui and the threads

    sfall_latest_version = None
    sfall.launch_latest_check(gui_queue)
    sfall_current = None
    zax_latest_version = None
    updates.launch_latest_check(gui_queue)
    game_config = None
    game_paths = []
    game_path = None
    wine_visible = False

    zax_yml = os.path.join(config_dir, "zax.yml")
    config = {}
    games = []
    if os.path.isfile(zax_yml):
        try:
            with open(zax_yml) as yf:
                config = yaml.load(yf)
            games = config["games"]
            game_paths = get_game_paths(games)
        except:
            os.makedirs(config_dir, exist_ok=True)

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

    games_layout = [
        [
            sg.Listbox(
                values=game_paths,
                size=(23, 17),
                key="listbox_games",
                enable_events=True,
                select_mode=SELECT_MODE_SINGLE,
                pad=((12, 5), (10, 10)),  # ((left, right), (top, bottom)) - for some reason it's skewed to the left
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
        listbox_games = window["listbox_games"]
        listbox_games(set_to_index=0)
        log("found games!")
    except:
        log("no games in list found")
    window["configs_loaded"](False)

    while True:  # Main event Loop

        event, values = window.read()

        log("event = {}".format(event))

        if event == "listbox_games" and values["listbox_games"]:
            game_path = values["listbox_games"][0]
            sfall_current = sfall.get_current(game_path)
            sfall.handle_ui_update(window, sfall_current, sfall_latest_version)
            wine.load(games, game_path, window)

        if event == sg.WIN_CLOSED:
            break

        if event == "add-game":
            dname = sg.popup_get_folder("Enter game path")
            if is_f2_game(dname):
                games.append({"path": dname})
                game_paths = get_game_paths(games)
                window["listbox_games"](values=game_paths)
                new_game_index = game_paths.index(dname)
                listbox_games(set_to_index=new_game_index)
            elif dname is not None:
                sg.popup("fallout2.exe not found in directory {}".format(dname))

        if game_path is not None:
            if event == "save":
                game_config.save(values)
                wine.save(zax_yml, config, games, game_path, values)

            if event == "play":
                launch_game(
                    game_path,
                    wine_prefix=values["wine_prefix"],
                    wine_debug=values["wine_debug"],
                    sfall_version=sfall_current,
                )

            if event == "remove-game":
                games = [g for g in games if g["path"] != game_path]
                game_paths = get_game_paths(games)
                window["listbox_games"](values=game_paths)
                if len(games) > 0:
                    listbox_games(set_to_index=0)

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

            game_config = handle_event(window, event, values, game_path, game_config)

    config["games"] = games
    with open(zax_yml, "w") as yf:
        yaml.dump(config, yf)
    window.close()


__main__(splash=splash)
