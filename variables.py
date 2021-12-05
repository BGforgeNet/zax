import appdirs
import os

appname = "zax"
config_dir = appdirs.user_config_dir(appname)
cache_dir = appdirs.user_cache_dir(appname)
backup_dir = os.path.join(cache_dir, "backup")
log_file = os.path.join(cache_dir, "zax.log")
# THEME = "Dark Brown"
# THEME = "material 1"
# THEME = "Topanga"
THEME = "light grey 6"
