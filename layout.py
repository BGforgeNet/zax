#!/usr/bin/env python3

from typing import OrderedDict
import ruamel.yaml
yaml = ruamel.yaml.YAML(typ="rt")
import os, sys

import layouts.fallout2_cfg
# sg.theme('Dark Brown')


layout = {}
layout['fallout2.cfg'] = layouts.fallout2_cfg.layout
print(layout['fallout2.cfg'])