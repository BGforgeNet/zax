import PySimpleGUIQt as pysg

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
    pysg.theme("reddit")
    pysg.theme_button_color(BUTTON_ENABLED_COLOR)  # more contrast for button names
    return pysg


sg = init(pysg)
