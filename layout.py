#!/usr/bin/env python3

import layouts.fallout2_cfg as fallout2_cfg
import layouts.f2_res_ini as f2_res_ini
import PySimpleGUIQt as sg

layout = {}
layout['fallout2.cfg'] = fallout2_cfg.layout
layout['f2_res.ini'] = f2_res_ini.layout

def handle_custom_event(config_path: str, window: sg.Window, event, values):
  print("custom 1")
  if config_path == 'f2_res.ini':
    print("custom 2")
    f2_res_ini.handle_event(window, event, values)
