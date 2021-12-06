import requests
import threading
from layouts.common import disable_element, enable_element
from zax_log import log
import webbrowser


def get_latest():
    try:
        resp = requests.get("https://api.github.com/repos/BGforgeNet/FO2tweaks/releases/latest", timeout=10)
        release = resp.json()
        latest = {}
        latest["ver"] = release["tag_name"]
        latest["url"] = release["assets"][0]["browser_download_url"]
        return latest
    except:
        log("failed to get latest ZAX version")
        try:
            log(resp)
        except:
            log("couldn't log http response")
        return {"ver": "unknown", "url": ""}


def launch_latest_check(gui_queue):
    log("start background thread")

    def launch_latest_check2(gui_queue):
        gui_queue.put({"type": "zax_latest", "value": get_latest()})

    try:
        threading.Thread(target=launch_latest_check2, args=(gui_queue,), daemon=True).start()
    except:
        log("failed to start ZAX latest check thread!")
    log("started background thread")


def handle_ui_update(window, zax_current, zax_latest=None):
    if zax_latest is None:
        latest = "Unknown"
    else:
        latest = zax_latest
    window["txt_zax_latest_version"](value=latest)
    disable_element("btn_zax_version_check", window)
    if zax_current != latest:
        enable_element("btn_zax_update", window)
    else:
        disable_element("btn_zax_update", window)
        window["txt_zax_current_version"](value=latest)
    return zax_latest


def update(zax_latest):
    webbrowser.open_new_tab(zax_latest["url"])
