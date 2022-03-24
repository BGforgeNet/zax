# external
import subprocess
import sys
import queue
import platform
import shutil
import os
from packaging import version

# internal
from zax.theme import sg
from zax import layout
from zax.config import GameConfig
import zax.sfall as sfall
import zax.updates as updates
from zax.zax_log import log, logger
from zax.variables import backup_dir, log_file, debug_dir
from zax.version import VERSION
from zax.layouts.zax import zax_layout
from zax.games import Games
from zax.zax_config import ZaxConfig
import zax.image_listbox as ilb
from zax.images.zax_png import zax_icon
from zax.pyqt_hacks import enable_tab, disable_tab, hide_tab

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

    if event == "tree_games" or event == "btn_sfall_update":
        window["game_switched"](False)
        game_config = GameConfig(game_path)
        game_config.load_from_disk(window, values, games, game_path)

    config_paths = game_config.config_paths
    for p in config_paths:
        layout.handle_custom_event(p, window, event, values)

    # this must go last, so that ui is updated properly on game switch
    if (
        event == "btn_trouble_enable_debug"
        or event == "tg_main"
        or event == "game_switched"
        or event == "btn_trouble_package_debug"
    ):
        layout.handle_non_config_event("trouble", window, event, values, game_config, game_path)

    if event == "tree_games":
        window["game_switched"](True)

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


def scan(games: Games, games_ilb: ilb.ImageListBox):
    games.scan()
    if len(games.paths) > 0:
        games_ilb.update(values=games.paths_with_icons)
        games_ilb.select(0)
    log("finished scanning")


def update_tabs(games: Games, window: sg.Window, game_config: GameConfig = None):
    main_tabs = ["tab_trouble", "tab_settings"]
    if len(games.paths) == 0:
        for tab_key in main_tabs:
            window[tab_key](disabled=True, visible=False)
            disable_tab(window, tab_key)
    else:
        for tab_key in main_tabs:
            window[tab_key](disabled=False, visible=True)
            enable_tab(window, tab_key)

    if game_config is not None:
        config_tabs = ["tab_fallout2.cfg", "tab_f2_res.ini", "tab_ddraw.ini"]
        enabled_tabs = ["tab_{}".format(cp) for cp in game_config.config_paths]
        disabled_tabs = [t for t in config_tabs if t not in enabled_tabs]
        for dt in disabled_tabs:
            disable_tab(window, dt)
        for et in enabled_tabs:
            enable_tab(window, et)


@logger.catch
def main(splash=False):
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
        sg.Tab("Game", [[layout.layout["fallout2.cfg"]]], key="tab_fallout2.cfg"),
        sg.Tab("HiRes", [[layout.layout["f2_res.ini"]]], key="tab_f2_res.ini", visible=False, disabled=True),
        sg.Tab("Sfall", [[layout.layout["ddraw.ini"]]], key="tab_ddraw.ini"),
        sg.Tab("Wine", layout.layout["wine"], key="tab_wine"),
    ]

    settings_layout = [
        [sg.TabGroup([settings_tabs], enable_events=True, key="tab_settings_sub")],
        [sg.Button("Save", key="btn_save")],
        [sg.Button("Play", key="btn_play")],
        # checkbox is a hack for triggering event to disable elements after config loading
        [
            sg.Checkbox(
                "game_switched",
                key="game_switched",
                enable_events=True,
                visible=False,
            )
        ],
    ]
    games_ilb = ilb.ImageListBox(
        games.paths_with_icons,
        headings=["tree_games"],
        num_rows=25,
        size=(24 * 9, 10 * 10),
        pad=((12, 5), (10, 10)),
        # size=(23, 17),
        select_mode=ilb.SELECT_MODE_SINGLE,
        enable_events=True,
        key="tree_games",
        default_icon=ilb.icon_folder,
        font="Helvetica 12",
        icon_size=(40, 40),
    )

    games_layout = [
        [games_ilb.element],
        [sg.Button("Add game", key="btn_add_game")],
        [sg.Button("Remove from list", key="btn_remove_game")],
    ]

    left_col = [[sg.TabGroup([[sg.Tab("Games", games_layout), sg.Tab("ZAX", zax_layout)]])]]
    right_col = [
        [
            sg.TabGroup(
                [
                    [
                        sg.Tab("Settings", settings_layout, key="tab_settings"),
                        sg.Tab("Troubleshooting", layout.layout["trouble"], key="tab_trouble"),
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
    window = sg.Window("ZAX", main_layout, finalize=True, resizable=False, icon=zax_icon)

    games_ilb.init_finalize(select_first=True)

    if len(games.paths) == 0:
        scan(games, games_ilb)
    if len(games.paths) > 0:
        log("found games!")
        games_ilb.update(values=games.paths_with_icons)
        games_ilb.select(0)
        event, values = window.read()
        game_path = games_ilb.value(values)[0]
        game_config = GameConfig(game_path)
        game_config.load_from_disk(window, values, games, game_path)
    update_tabs(games, window, game_config)
    if not wine_visible:
        disable_tab(window, "tab_wine")
        hide_tab(window, "tab_wine")

    window["dd_zax_theme"](zax_config.theme)

    # this hack allows to trigger ui updates AFTER game list changes
    window["game_switched"](False)

    while True:  # Main event Loop

        event, values = window.read()

        log("event = {}".format(event))
        if event in values:
            log("value = {}".format(values[event]))
            if event == "tree_games":
                log(games_ilb.value(values))

        if event == sg.WIN_CLOSED:
            break

        if event == "game_switched" and values[event] is True:
            update_tabs(games, window, game_config)

        if event == "tree_games":
            if len(games.paths) > 0:
                game_path = games_ilb.value(values)[0]
                sfall_current = sfall.get_current(game_path)
                sfall.handle_ui_update(window, sfall_current, sfall_latest_version)
                update_tabs(games, window, game_config)
            else:
                update_tabs(games, window)

        if event == "btn_zax_scan":
            scan(games, games_ilb)
            continue

        if event == "btn_add_game":
            dir_path = sg.popup_get_folder("Enter game path")
            if dir_path:  # if a dir is selected
                zax_config.add_game(dir_path)
                games_ilb.update(values=games.paths_with_icons)
                games_ilb.select(dir_path)
                continue

        if event == "btn_remove_game":
            if len(games.paths) > 0:
                zax_config.remove_game(game_path)
                games_ilb.update(values=games.paths_with_icons)
                if len(games.paths) > 0:
                    game_path = games.paths[0]
                    games_ilb.select(0)
                else:
                    game_path = None
                    game_config = None

        if game_path is not None:
            if event == "btn_save":
                game_config.save(values)
                zax_config.save(game_path, wine_prefix=values["wine_prefix"], wine_debug=values["wine_debug"])

            if event == "btn_play":
                launch_game(
                    game_path,
                    wine_prefix=values["wine_prefix"],
                    wine_debug=values["wine_debug"],
                    sfall_version=sfall_current,
                )
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


if __name__ == "__main__":
    main(splash=splash)
