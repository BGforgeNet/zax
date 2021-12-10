import appdirs
import os

appname = "zax"
config_dir = appdirs.user_config_dir(appname)
zax_yml = os.path.join(config_dir, "zax.yml")
cache_dir = appdirs.user_cache_dir(appname)
backup_dir = os.path.join(cache_dir, "backup")
debug_dir = os.path.join(cache_dir, "debug")
log_file = os.path.join(cache_dir, "zax.log")
tmp_dir = os.path.join(cache_dir, "tmp")
os.makedirs(tmp_dir, exist_ok=True)
