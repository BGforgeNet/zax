import PySimpleGUIQt as sg

from .common import disable_element, enable_element

layout = [
    [sg.Text("This tab contains shortcuts for resolving various common issues,", justification="c")],
    [sg.Text(" and allows you to prepare an archive with information needed in bug reports.", justification="c")],
    [sg.HSeperator()],
    [sg.Text("Bug reports", justification="l")],
    [
        sg.Button("Enable debug", tooltip="Enable sfall and game debug", key="btn_trouble_enable_debug"),
        sg.Button(
            "Prepare debug package",
            tooltip="Create an archive with all relevant configs and versions",
            key="btn_trouble_package_debug",
        ),
    ],
]


def handle_event(window: sg.Window, event: str, values, game_config):
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
        else:
            enable_element("btn_trouble_enable_debug", window)

    if event == "btn_trouble_enable_debug":
        window["ddraw.ini-Debugging-DebugMode"]("debug.log")
        values["ddraw.ini-Debugging-DebugMode"] = "debug.log"  # setting separately because this button saves config too
        for k in debug_keys:
            window[k](True)
            values[k] = True
        disable_element("btn_trouble_enable_debug", window)
        game_config.save(values)
