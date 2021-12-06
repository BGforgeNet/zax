import PySimpleGUIQt as sg

from variables import BUTTON_DISABLED_COLOR, set_theme
from version import VERSION

set_theme(sg)

zax_layout = [
    [sg.HSeperator()],
    [sg.Text("Version", justification="c")],
    [
        sg.Text("Current:"),
        sg.Text(VERSION, key="txt_zax_current_version"),
        sg.Button("Update", key="btn_zax_update"),
    ],
    [
        sg.Text("Latest:"),
        sg.Text("Unknown", key="txt_zax_latest_version"),
        sg.Button("Check", key="btn_zax_version_check", disabled=True, button_color=BUTTON_DISABLED_COLOR),
    ],
    [sg.HSeperator()],
    [sg.Text("Backup directory", justification="c")],
    [
        sg.Button("Open", key="zax-backup-open", enable_events=True),
        sg.Button("Wipe", key="zax-backup-wipe", enable_events=True),
    ],
    [sg.HSeperator()],
    [sg.Text("Log file", justification="c")],
    [sg.Button("View", key="zax-log-view", enable_events=True)],
]
