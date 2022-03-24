from typing import OrderedDict
import ruamel.yaml

# internal
from zax.theme import sg
from zax.layouts.common import frame, checkbox, spin, dropdown, qinput, tab, get_ini_data, slider, radio

yaml = ruamel.yaml.YAML(typ="rt")

c = get_ini_data("fallout2.cfg")

tabs = OrderedDict()

tabs["Preferences"] = [
    slider(c, "preferences", "brightness"),
    radio(c, "preferences", "game_difficulty"),
    checkbox(c, "preferences", "item_highlight"),
    checkbox(c, "preferences", "language_filter"),
    slider(c, "preferences", "mouse_sensitivity"),
    checkbox(c, "preferences", "running"),
    checkbox(c, "preferences", "subtitles"),
    slider(c, "preferences", "text_base_delay"),
    slider(c, "preferences", "text_line_delay", visible=False),  # todo: tie to text_base_delay with hook
    frame(
        "Sound volume",
        [
            slider(c, "sound", "master_volume"),
            slider(c, "sound", "music_volume"),
            slider(c, "sound", "sndfx_volume"),
            slider(c, "sound", "speech_volume"),
        ],
    ),
]
tabs["Combat"] = [
    radio(c, "preferences", "combat_difficulty"),
    frame(
        "Speed",
        [
            slider(c, "preferences", "combat_speed"),
            checkbox(c, "preferences", "player_speedup"),
        ],
    ),
    checkbox(c, "preferences", "combat_looks"),
    radio(c, "preferences", "combat_messages"),
    checkbox(c, "preferences", "combat_taunts"),
    radio(c, "preferences", "target_highlight"),
    dropdown(c, "preferences", "violence_level"),
]

tabs["Advanced"] = [
    frame(
        "System",
        [
            spin(c, "system", "art_cache_size"),
            checkbox(c, "system", "color_cycling"),
            qinput(c, "system", "critter_dat"),
            qinput(c, "system", "critter_patches"),
            spin(c, "system", "cycle_speed_factor"),
            qinput(c, "system", "executable"),
            spin(c, "system", "free_space"),
            checkbox(c, "system", "hashing"),
            checkbox(c, "system", "interrupt_walk"),
            qinput(c, "system", "language"),
            qinput(c, "system", "master_dat"),
            qinput(c, "system", "master_patches"),
            checkbox(c, "system", "scroll_lock"),
            spin(c, "system", "splash"),
        ],
    ),
    frame(
        "Sound",
        [
            checkbox(c, "sound", "music"),
            checkbox(c, "sound", "sounds"),
            checkbox(c, "sound", "speech"),
            qinput(c, "sound", "music_path1", size=(200, None)),
            qinput(c, "sound", "music_path2", size=(200, None)),
            spin(c, "sound", "cache_size"),
            dropdown(c, "sound", "device"),
            qinput(c, "sound", "dma"),
            checkbox(c, "sound", "initialize"),
            qinput(c, "sound", "irq"),
            qinput(c, "sound", "port"),
        ],
    ),
]

tabs["Debug"] = [
    frame(
        "Main",
        [
            checkbox(c, "debug", "output_map_data_info"),
            checkbox(c, "debug", "show_load_info"),
            checkbox(c, "debug", "show_script_messages"),
            checkbox(c, "debug", "show_tile_num"),
        ],
    ),
    frame(
        "Sound",
        [
            checkbox(c, "sound", "debug"),
            checkbox(c, "sound", "debug_sfxc"),
        ],
    ),
]

tab_list = [tab(t, tabs[t], key="fallout2.cfg-{}".format(t)) for t in tabs]

layout = sg.TabGroup([tab_list])
