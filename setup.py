from distutils.core import setup
import py2exe
import sys
import os

sys.argv.append("py2exe")

data_files = []
for f in os.listdir("formats"):
    rel_path = os.path.join("formats", f)
    if os.path.isfile(rel_path):  # skip directories
        f2 = "formats", [rel_path]
        data_files.append(f2)

setup(
    options={"py2exe": {"bundle_files": 3, "compressed": True}},
    data_files=data_files,
    windows=[{"script": "zax.py"}],
)
