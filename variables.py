import appdirs
import os

appname = "zax"
config_dir = appdirs.user_config_dir(appname)
cache_dir = appdirs.user_cache_dir(appname)
backup_dir = os.path.join(cache_dir, "backup")
log_file = os.path.join(cache_dir, "zax.log")

# some notable themese
# THEME = "Dark Brown"
# THEME = "material 3"
# THEME = "Topanga"
# THEME = "light grey 6"
# THEME = "system default for real"
# THEME = "dark grey 7"
# THEME = "reddit"


def set_theme(sg):
    sg.theme("reddit")
    sg.theme_button_color(("white", "#004880"))  # more contrast for button names
