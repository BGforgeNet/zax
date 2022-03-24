from typing import OrderedDict
import ruamel.yaml

# internal
from zax.theme import sg
from zax.layouts.common import (
    frame,
    checkbox,
    spin,
    dropdown,
    qinput,
    tab,
    disable_if,
    get_ini_data,
    radio,
    enable_element,
    disable_element,
    enable_if,
)

yaml = ruamel.yaml.YAML(typ="rt")

c = get_ini_data("f2_res.ini")

tabs = OrderedDict()

resolution_options = [
    "...",
    "1920x1080",
    "1600x900",
    "1366x768",
    "1280x1024",
    "1280x960",
    "1280x800",
    "1280x720",
    "1152x864",
    "1024x768",
    "1024x576",
    "960x720",
    "960x600",
    "960x540",
    "800x600",
    "640x480",
]
resolution_options_x2 = [
    "...",
    "1920x1080",
    "1600x900",
    "1280x1024",
    "1280x960",
]

resolution = frame(
    "Resolution",
    [
        [
            sg.Text(text="Select from common options"),
            sg.Combo(
                resolution_options,
                readonly=True,
                size=(155, None),
                key="f2_res.ini-resolution",
                enable_events=True,
                pad=(50, 50),
            ),
        ],
        [
            sg.Text(text="Or enter manually"),
            sg.Stretch(),
            sg.Spin(
                [i for i in range(640, 3840 + 1)],
                initial_value=640,
                size=(70, None),
                key="f2_res.ini-MAIN-SCR_WIDTH",
                enable_events=True,
            ),
            sg.Text("x"),
            sg.Spin(
                [i for i in range(480, 2160 + 1)],
                initial_value=480,
                size=(70, None),
                key="f2_res.ini-MAIN-SCR_HEIGHT",
                enable_events=True,
            ),
        ],
    ],
)


tabs["Main"] = [
    frame(
        "Graphics",
        [
            dropdown(c, "MAIN", "GRAPHICS_MODE"),
            checkbox(c, "MAIN", "SCALE_2X"),
            checkbox(c, "EFFECTS", "IS_GRAY_SCALE"),
            radio(c, "MAIN", "WINDOWED"),
            # qinput(c, 'MAIN', 'SCR_WIDTH'), # added manually
            # qinput(c, 'MAIN', 'SCR_HEIGHT'),
            checkbox(c, "MAIN", "WINDOWED_FULLSCREEN"),
            frame(
                "Fullscreen",
                [
                    dropdown(c, "MAIN", "COLOUR_BITS", size=(100, None)),
                    spin(c, "MAIN", "REFRESH_RATE"),
                ],
            ),
            resolution,
        ],
    ),
    # checkbox(c, 'HI_RES_PANEL', 'DISPLAY_LIST_DESCENDING'), # useless
    frame(
        "Maps",
        [
            checkbox(c, "MAPS", "EDGE_CLIPPING_ON"),
            checkbox(c, "MAPS", "IGNORE_MAP_EDGES"),
            checkbox(c, "MAPS", "IGNORE_PLAYER_SCROLL_LIMITS"),
            qinput(c, "MAPS", "SCROLL_DIST_X"),
            qinput(c, "MAPS", "SCROLL_DIST_Y"),
        ],
    ),
    spin(c, "MAPS", "NumPathNodes"),
    frame(
        "Fog of war",
        [
            checkbox(c, "MAPS", "FOG_OF_WAR"),
            spin(c, "MAPS", "FOG_LIGHT_LEVEL"),
        ],
    ),
    frame(
        "Delays",
        [
            spin(c, "OTHER_SETTINGS", "SPLASH_SCRN_TIME"),
            spin(c, "OTHER_SETTINGS", "FADE_TIME_MODIFIER"),
        ],
    ),
]

tabs["Scaling"] = [
    radio(c, "MOVIES", "MOVIE_SIZE"),
    radio(c, "MAINMENU", "MAIN_MENU_SIZE"),
    frame(
        "HiRes menu backgronud",
        [
            checkbox(c, "MAINMENU", "USE_HIRES_IMAGES"),
            spin(c, "MAINMENU", "MENU_BG_OFFSET_X"),
            spin(c, "MAINMENU", "MENU_BG_OFFSET_Y"),
            checkbox(c, "MAINMENU", "SCALE_BUTTONS_AND_TEXT_MENU"),
        ],
    ),
    radio(c, "STATIC_SCREENS", "DEATH_SCRN_SIZE"),
    radio(c, "STATIC_SCREENS", "END_SLIDE_SIZE"),
    radio(c, "STATIC_SCREENS", "HELP_SCRN_SIZE"),
    radio(c, "STATIC_SCREENS", "SPLASH_SCRN_SIZE"),
]

tabs["Interface"] = [
    frame(
        "Interface bar",
        [
            radio(c, "IFACE", "IFACE_BAR_MODE"),
            dropdown(c, "IFACE", "IFACE_BAR_SIDE_ART", size=(180, None)),
            dropdown(c, "IFACE", "IFACE_BAR_SIDES_ORI", size=(180, None)),
            spin(c, "IFACE", "IFACE_BAR_WIDTH"),
        ],
    ),
    frame(
        "Dialog and barter",
        [
            checkbox(c, "OTHER_SETTINGS", "DIALOG_SCRN_BACKGROUND"),
            checkbox(c, "OTHER_SETTINGS", "DIALOG_SCRN_ART_FIX"),
            checkbox(c, "OTHER_SETTINGS", "BARTER_PC_INV_DROP_FIX"),
            checkbox(c, "INPUT", "SCROLLWHEEL_FOCUS_PRIMARY_MENU"),
        ],
    ),
    frame(
        "Alternate ammo metre",
        [
            dropdown(c, "IFACE", "ALTERNATE_AMMO_METRE"),
            qinput(c, "IFACE", "ALTERNATE_AMMO_LIGHT"),
            qinput(c, "IFACE", "ALTERNATE_AMMO_DARK"),
        ],
    ),
]

tabs["Advanced"] = [
    checkbox(c, "OTHER_SETTINGS", "CD_CHECK"),
    frame(
        "Troubleshooting",
        [
            checkbox(c, "INPUT", "ALT_MOUSE_INPUT"),
            checkbox(c, "INPUT", "EXTRA_WIN_MSG_CHECKS"),
            checkbox(c, "OTHER_SETTINGS", "CPU_USAGE_FIX"),
            checkbox(c, "OTHER_SETTINGS", "FADE_TIME_RECALCULATE_ON_FADE"),
        ],
    ),
    frame(
        "System",
        [
            qinput(c, "MAIN", "f2_res_dat", size=(200, None)),
            qinput(c, "MAIN", "f2_res_patches", size=(200, None)),
            checkbox(c, "MAIN", "UAC_AWARE", visible=False, disabled=True),
        ],
    ),
]

tab_list = [tab(t, tabs[t], key="f2_res.ini-{}".format(t)) for t in tabs]

layout = sg.TabGroup([tab_list])


def handle_event(window: sg.Window, event: str, values: dict):
    res_key = "f2_res.ini-resolution"
    res_x_key = "f2_res.ini-MAIN-SCR_WIDTH"
    res_y_key = "f2_res.ini-MAIN-SCR_HEIGHT"

    dummy_choice = "..."  # setting dropdown based on x/y values is too hard due to lack of proper event
    if (event == res_key) and (values[res_key] != dummy_choice):
        new_res = values[res_key]
        new_x = int(new_res.split("x")[0])
        new_y = int(new_res.split("x")[1])
        window[res_x_key](new_x)
        window[res_y_key](new_y)
        window[res_key](dummy_choice)

    # always disable UAC aware
    if event == "-LIST-":
        window["f2_res.ini-MAIN-UAC_AWARE"](False)

    # double min resolution on scale2x
    scale_2x_key = "f2_res.ini-MAIN-SCALE_2X"
    if event == scale_2x_key:
        if values[scale_2x_key] is True:
            window[res_key](values=resolution_options_x2)
            if int(values[res_x_key]) < 1280:
                window[res_x_key](1280)
            if int(values[res_y_key]) < 960:
                window[res_y_key](960)
        else:
            window[res_key](values=resolution_options)

    # full screen only options
    fullscreen_key = "f2_res.ini-MAIN-WINDOWED-0"
    windowed_key = "f2_res.ini-MAIN-WINDOWED-1"
    colour_bits_key = "f2_res.ini-MAIN-COLOUR_BITS"
    refresh_rate_key = "f2_res.ini-MAIN-REFRESH_RATE"
    windowed_fullscreen_key = "f2_res.ini-MAIN-WINDOWED_FULLSCREEN"
    enable_events = [fullscreen_key, "-LIST-", "configs_loaded"]
    disable_events = [windowed_key, "-LIST-", "configs_loaded"]
    if (event in enable_events) and values[fullscreen_key]:
        enable_element(colour_bits_key, window, values)
        enable_element(refresh_rate_key, window, values)
        disable_element(windowed_fullscreen_key, window, values, new_value=0)
    if (event in disable_events) and values[windowed_key]:
        disable_element(colour_bits_key, window, values)
        disable_element(refresh_rate_key, window, values)
        enable_element(windowed_fullscreen_key, window, values)

    disable_if(
        "f2_res.ini-INPUT-ALT_MOUSE_INPUT",
        True,
        "f2_res.ini-INPUT-EXTRA_WIN_MSG_CHECKS",
        window,
        values,
        event,
        disabled_value=True,
    )

    for k in ["f2_res.ini-IFACE-ALTERNATE_AMMO_LIGHT", "f2_res.ini-IFACE-ALTERNATE_AMMO_DARK"]:
        enable_if("f2_res.ini-IFACE-ALTERNATE_AMMO_METRE", "Single colour", k, window, values, event)

    enable_if("f2_res.ini-MAPS-FOG_OF_WAR", True, "f2_res.ini-MAPS-FOG_LIGHT_LEVEL", window, values, event)

    for k in ["f2_res.ini-MAINMENU-MENU_BG_OFFSET_X", "f2_res.ini-MAINMENU-MENU_BG_OFFSET_Y"]:
        enable_if("f2_res.ini-MAINMENU-USE_HIRES_IMAGES", True, k, window, values, event)
    enable_if(
        "f2_res.ini-MAINMENU-USE_HIRES_IMAGES",
        True,
        "f2_res.ini-MAINMENU-SCALE_BUTTONS_AND_TEXT_MENU",
        window,
        values,
        event,
        disabled_value=False,
    )

    for k in ["f2_res.ini-MAPS-SCROLL_DIST_X", "f2_res.ini-MAPS-SCROLL_DIST_Y"]:
        enable_if("f2_res.ini-MAPS-IGNORE_PLAYER_SCROLL_LIMITS", False, k, window, values, event)
