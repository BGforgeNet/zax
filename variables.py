import appdirs
import os

appname = "zax"
config_dir = appdirs.user_config_dir(appname)
cache_dir = appdirs.user_cache_dir(appname)
backup_dir = os.path.join(cache_dir, "backup")
debug_dir = os.path.join(cache_dir, "debug")
log_file = os.path.join(cache_dir, "zax.log")

# some notable themese
# THEME = "Dark Brown"
# THEME = "material 3"
# THEME = "Topanga"
# THEME = "light grey 6"
# THEME = "system default for real"
# THEME = "dark grey 7"
# THEME = "reddit"

BUTTON_ENABLED_COLOR = ("white", "#004880")
BUTTON_DISABLED_COLOR = ("white", "grey")


def set_theme(sg):
    sg.theme("reddit")
    sg.theme_button_color(BUTTON_ENABLED_COLOR)  # more contrast for button names
