import pprint
import ruamel.yaml

# internal
from zax.theme import sg, BUTTON_DISABLED_COLOR, BUTTON_ENABLED_COLOR
from zax.resources import RESOURCES

yaml = ruamel.yaml.YAML(typ="rt")

pp = pprint.PrettyPrinter(indent=2)


def get_ini_data(filename):
    data = yaml.load(RESOURCES.ini_formats[filename])
    return data


def checkbox(cfg_data, section, key, visible=True, disabled=False):
    item = cfg_data[section][key]
    try:
        name = item["name"]
    except:
        name = key
    try:
        tooltip = item["desc"]
    except:
        tooltip = None
    return [
        sg.Checkbox(
            name,
            key="{}-{}-{}".format(cfg_data["zax"]["path"], section, key),
            enable_events=True,
            tooltip=tooltip,
            visible=visible,
            disabled=disabled,
        )
    ]


def tab(tab_name, items, key=None):
    if key:
        return sg.Tab(tab_name, [[sg.Column(items, scrollable=True, size=(500, 500))]], key=key)
    else:
        return sg.Tab(tab_name, [[sg.Column(items, scrollable=True, size=(500, 500))]])


def frame(name, items):
    # frame title is broken https://github.com/PySimpleGUI/PySimpleGUI/issues/2733
    # return [sg.Frame(name, items)]
    return [sg.Frame("", [[sg.HorizontalSeparator()], [sg.T(name)], [sg.Frame("", items)]])]


def name_wkey(cfg_data, section, key):
    item = cfg_data[section][key]
    try:
        name = item["name"]
    except:
        name = key
    wkey = "{}-{}-{}".format(cfg_data["zax"]["path"], section, key)
    return name, wkey


def dropdown(cfg_data, section, key, size=(150, None), readonly=True):
    item = cfg_data[section][key]
    name, wkey = name_wkey(cfg_data, section, key)
    options = [str(o["name"]) for o in item["options"]]
    return [
        sg.T("       " + name),
        sg.Combo(options, readonly=readonly, size=size, key=wkey, enable_events=True, pad=(50, 50)),
    ]  # combo size/justification is broken https://github.com/PySimpleGUI/PySimpleGUI/issues/4474


def radio(cfg_data, section, key):
    item = cfg_data[section][key]
    name, wkey = name_wkey(cfg_data, section, key)
    options = {o["name"]: o["value"] for o in item["options"]}
    return [sg.T("       " + name), sg.Stretch()] + [
        sg.Radio(o, wkey, key="{}-{}".format(wkey, options[o]), enable_events=True) for o in options
    ]


def slider(cfg_data, section, key, visible=True):
    item = cfg_data[section][key]
    name, wkey = name_wkey(cfg_data, section, key)
    if "min" not in item:
        min = 0
    else:
        min = item["min"]
    if "max" not in item:
        max = 100
    else:
        max = item["max"]
    if "interval" not in item:
        interval = (max - min) / 10
    else:
        interval = item["interval"]
    if "type" in item and item["type"] == "float":
        min = min * item["float_base"]
        max = max * item["float_base"]
        interval = interval * item["float_base"]
    return [
        sg.T("       " + name, visible=visible),
        sg.Slider(
            range=(min, max + 1),
            orientation="horizontal",
            key=wkey,
            size=(200, None),
            tick_interval=interval,
            enable_events=True,
            visible=visible,
        ),
    ]


def spin(cfg_data, section, key):
    item = cfg_data[section][key]
    name, wkey = name_wkey(cfg_data, section, key)
    if "min" not in item:
        min = 0
    else:
        min = item["min"]
    if "max" not in item:
        if "min" in item:
            max = abs(min) * 2  # just a guess
        else:
            max = 100
    else:
        max = item["max"]
    try:
        tooltip = item["desc"]
    except:
        tooltip = None
    return [
        sg.Text("       " + name),
        sg.Spin(
            [i for i in range(min, max + 1)],
            initial_value=0,
            size=(100, None),
            key=wkey,
            enable_events=True,
            tooltip=tooltip,
        ),
    ]


# todo: validate input for ints (including negative in some cases)
def qinput(cfg_data, section, key, size=(100, None)):
    name, wkey = name_wkey(cfg_data, section, key)
    try:
        data_type = cfg_data[section][key]["type"]
        if data_type == "dx_key":
            return [
                sg.Text("       " + name),
                sg.InputText("", key=wkey, size=(50, None), enable_events=True, metadata="dx_key"),
            ]
        else:
            return [sg.Text("       " + name), sg.InputText("", key=wkey, size=size, enable_events=True)]
    except:
        return [sg.Text("       " + name), sg.InputText("", key=wkey, size=size, enable_events=True)]


def enable_element(key: str, window: sg.Window, values={}, new_value=None, event=None):
    if type(window[key]) is sg.Button:
        window[key](disabled=False)
        window[key](button_color=BUTTON_ENABLED_COLOR)
        return

    old_value = values[key]
    window[key](
        text_color=sg.theme_element_text_color()
    )  # must go before disabled state change, or checkbox will flip state
    window[key](disabled=False)
    if new_value is not None:
        window[key](value=new_value)

    # without this, checkbox auto unchecks on enabling
    # with it, but without type check, disabled values don't update on game switch
    # without event check, value gets stuck on game switch too
    elif (type(window[key]) is sg.Checkbox) and (event not in ["-LIST-", "configs_loaded"]):
        window[key](value=old_value)


def disable_element(key: str, window: sg.Window, values={}, new_value=None, event=None):
    if type(window[key]) is sg.Button:
        window[key](disabled=True)
        window[key](button_color=BUTTON_DISABLED_COLOR)
        return

    old_value = values[key]
    window[key](text_color="grey")  # doesn't work in some items, for example dropdown. Works for spin.
    window[key](disabled=True)
    if new_value is not None:
        window[key](value=new_value)

    # see enable_element comment
    elif (type(window[key]) is sg.Checkbox) and (event not in ["-LIST-", "configs_loaded"]):
        window[key](value=old_value)


def enable_if(trigger_key, trigger_key_value, element_key, window, values, event, disabled_value=None):
    trigger_events = ["-LIST-", "configs_loaded"] + [trigger_key]
    if event in trigger_events:
        if values[trigger_key] == trigger_key_value:
            enable_element(element_key, window, values, event=event)
        else:
            disable_element(element_key, window, values, event=event, new_value=disabled_value)


def disable_if(trigger_key, trigger_key_value, element_key, window, values, event, disabled_value=None):
    trigger_events = ["-LIST-", "configs_loaded"] + [trigger_key]
    if event in trigger_events:
        if values[trigger_key] == trigger_key_value:
            disable_element(element_key, window, values, event=event, new_value=disabled_value)
        else:
            enable_element(element_key, window, values, event=event)
