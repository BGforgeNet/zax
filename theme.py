import PySimpleGUIQt as pysg
import ruamel.yaml
from variables import zax_yml
# some notable themes
# THEME = "Dark Brown"
# THEME = "material 3"
# THEME = "Topanga"
# THEME = "light grey 6"
# THEME = "system default for real"
# THEME = "dark grey 7"
# THEME = "reddit"

BUTTON_ENABLED_COLOR = ("white", "#004880")
BUTTON_DISABLED_COLOR = ("white", "grey")


def init(pysg):
    # ZaxConfig is not initialized yet, loading theme manially
    yaml = ruamel.yaml.YAML(typ="rt")
    try:
        with open(zax_yml) as yf:
            config = yaml.load(yf)
            theme = config["theme"]
    except:
        theme = "light"

    if theme == "light":
        pysg.theme("reddit")
        pysg.theme_button_color(BUTTON_ENABLED_COLOR)  # more contrast for button names
    else:
        pysg.theme("Dark Brown")
    return pysg


sg = init(pysg)
