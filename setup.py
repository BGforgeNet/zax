from distutils.core import setup
import py2exe
import sys
import os
import site

sys.argv.append("py2exe")

data_files = []
for f in os.listdir("formats"):
    rel_path = os.path.join("formats", f)
    if os.path.isfile(rel_path):  # skip directories
        f2 = "formats", [rel_path]
        data_files.append(f2)
platforms_dir = os.path.join(site.getsitepackages()[1], "PySide2", "Qt", "plugins", "platforms")
qwindows_dll = os.path.join(platforms_dir, "qwindows.dll")
data_files.append("platforms", [qwindows_dll])

setup(
    options={"py2exe": {"bundle_files": 3, "compressed": True}},
    data_files=data_files,
    windows=[{"script": "zax.py"}],
)
