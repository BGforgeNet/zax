import appdirs
import os

appname = 'zax'
config_dir = appdirs.user_config_dir(appname)
cache_dir = appdirs.user_cache_dir(appname)
backup_dir = os.path.join(cache_dir, "backup")
