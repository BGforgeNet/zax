#!/usr/bin/env python3

from typing import OrderedDict
import PySimpleGUIQt as sg
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys
from .common import *

sg.theme('Dark Brown')

c = get_ini_data('f2_res.ini')

tabs = OrderedDict()

tabs['Main'] = [
  checkbox(c, 'MAIN', 'UAC_AWARE'),
]

tab_list = [tab(t, tabs[t]) for t in tabs]

layout = sg.TabGroup([tab_list])
