import layouts.fallout2_cfg as fallout2_cfg
import layouts.f2_res_ini as f2_res_ini
import layouts.ddraw_ini as ddraw_ini
import layouts.wine as wine
import PySimpleGUIQt as sg
import layouts.trouble as trouble


layout = {}
layout["fallout2.cfg"] = fallout2_cfg.layout
layout["f2_res.ini"] = f2_res_ini.layout
layout["ddraw.ini"] = ddraw_ini.layout
layout["wine"] = wine.layout
layout["trouble"] = trouble.layout


def handle_custom_event(config_path: str, window: sg.Window, event, values):
    if config_path == "f2_res.ini":
        f2_res_ini.handle_event(window, event, values)
    if config_path == "ddraw.ini":
        ddraw_ini.handle_event(window, event, values)


def handle_non_config_event(type: str, window: sg.Window, event, values, game_config=None):
    if type == "trouble":
        trouble.handle_event(window, event, values, game_config)
