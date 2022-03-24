import tempfile
import requests
import os
from urllib.request import urlretrieve
import py7zr
import iniparse
import shutil
import pefile
import threading
import datetime
from zax.common import cd
from zax.layouts.common import disable_element, enable_element
from zax.zax_log import log
from zax.variables import backup_dir


def get_latest():
    try:
        resp = requests.get("https://sourceforge.net/projects/sfall/best_release.json", timeout=10)
        release = resp.json()["release"]
        latest = {}
        latest["ver"] = release["filename"].split("_")[-1].rsplit(".", 1)[0]
        latest["url"] = release["url"]
        return latest
    except:
        log("failed to get latest sfall version")
        try:
            log(resp)
        except:
            log("couldn't log http response")
        return {"ver": "Unknown", "url": ""}


def get_current(path):
    pe = pefile.PE(os.path.join(path, "ddraw.dll"))
    ver = pe.FileInfo[0][0].StringTable[0].entries[b"FileVersion"]
    ver = ver.decode("ascii")
    return ver


def download(url, game_path):
    log("update start")

    with tempfile.TemporaryDirectory(prefix="zax-") as tmpdir:
        dst = os.path.join(tmpdir, "sfall.7z")
        urlretrieve(url, dst)
        with cd(tmpdir):
            with py7zr.SevenZipFile("sfall.7z", mode="r") as z:
                z.extractall()
            with open(os.path.join(game_path, "ddraw.ini")) as fh:
                old_ini = iniparse.INIConfig(fh, optionxformvalue=None)  # iniparse keep case for new keys
            with open("ddraw.ini") as fh:
                new_ini = iniparse.INIConfig(fh, optionxformvalue=None)
            for s in old_ini:
                for k in old_ini[s]:
                    new_ini[s][k] = old_ini[s][k]
            content = str(new_ini)
            content = content.replace("\n", "\r\n")  # for old windows users
            content = content.replace(" = ", "=")  # iniparse adds spaces around new keys
            with open("ddraw.ini", "w") as fh:
                fh.write(content)
            os.remove("sfall.7z")
            backup(game_path, tmpdir)
            shutil.copytree(tmpdir, game_path, dirs_exist_ok=True)
    log("update finished")


def backup(game_dir, tmp_dir, backup_dir=backup_dir):
    backup_dir = os.path.join(backup_dir, datetime.datetime.now().strftime("%Y-%m-%d_%H-%M-%S"))
    with cd(tmp_dir):
        for root, dirs, files in os.walk(os.curdir):
            for f in files:
                f_relpath = os.path.join(root, f)
                f_gamepath = os.path.join(game_dir, f_relpath)
                if os.path.isfile(f_gamepath):
                    f_backpath = os.path.join(backup_dir, f_relpath)
                    os.makedirs(os.path.dirname(f_backpath), exist_ok=True)
                    shutil.copy(f_gamepath, f_backpath)
    log("backed up to {}".format(backup_dir))


def launch_latest_check(gui_queue):
    log("start background thread")

    def launch_latest_check2(gui_queue):
        gui_queue.put({"type": "sfall_latest", "value": get_latest()})

    try:
        threading.Thread(target=launch_latest_check2, args=(gui_queue,), daemon=True).start()
    except:
        log("failed to start sfall latest check thread!")
    log("started background thread")


def handle_ui_update(window, sfall_current, sfall_latest_version=None):
    if sfall_latest_version is None:
        latest = "Unknown"
    else:
        latest = sfall_latest_version
    window["txt_sfall_current"](value=sfall_current)
    window["txt_sfall_latest"](value=latest)
    disable_element("btn_sfall_check", window)
    if sfall_current != latest:
        enable_element("btn_sfall_update", window)
    else:
        disable_element("btn_sfall_update", window)
        window["txt_sfall_current"](value=latest)


def update(window, sfall_latest_data, game_path):
    download(sfall_latest_data["url"], game_path)
    disable_element("btn_sfall_update", window)
    window["txt_sfall_current"](value=sfall_latest_data["ver"])
