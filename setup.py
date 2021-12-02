from distutils.core import setup
import py2exe
import sys
import os

sys.argv.append("py2exe")

data_files = []
for files in os.listdir("formats"):
    f1 = "formats" + files
    if os.path.isfile(f1):  # skip directories
        f2 = "formats", [f1]
        data_files.append(f2)

setup(
    options={"py2exe": {"bundle_files": 3, "compressed": True}},
    data_files=data_files,
    windows=[{"script": "zax.py"}],
)
