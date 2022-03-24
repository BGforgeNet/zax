import PySimpleGUIQt as sg
import ruamel.yaml
from zax.variables import zax_yml

# some notable themes
# THEME = "Dark Brown"
# THEME = "material 3"
# THEME = "Topanga"
# THEME = "light grey 6"
# THEME = "system default for real"
# THEME = "dark grey 7"
# THEME = "reddit"


def get_theme():
    # ZaxConfig is not initialized yet, loading theme manially
    yaml = ruamel.yaml.YAML(typ="rt")
    try:
        with open(zax_yml) as yf:
            config = yaml.load(yf)
            theme = config["theme"]
    except:
        theme = "light"
    return theme


theme = get_theme()
if theme == "light":
    BUTTON_ENABLED_COLOR = ("white", "#004880")
    BUTTON_DISABLED_COLOR = ("white", "grey")
    sg.theme("reddit")
    sg.theme_button_color(BUTTON_ENABLED_COLOR)  # more contrast for button names
else:
    sg.theme("Dark Brown")
    BUTTON_ENABLED_COLOR = sg.theme_button_color()
    BUTTON_DISABLED_COLOR = ("grey", "#333333")

TEXT_DISABLED_COLOR = "grey"
