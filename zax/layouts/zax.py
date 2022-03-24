from zax.theme import sg, BUTTON_DISABLED_COLOR
from zax.version import VERSION

zax_layout = [
    [sg.HSeperator()],
    [sg.Text("Version", justification="c")],
    [sg.Text("Current:"), sg.Text(VERSION, key="txt_zax_current_version"), sg.Text("")],  # dummy for alignment
    [
        sg.Text("Latest:"),
        sg.Text("Unknown", key="txt_zax_latest_version"),
        sg.Button("Check", key="btn_zax_version_check", disabled=True, button_color=BUTTON_DISABLED_COLOR),
    ],
    [sg.Button("Download latest", key="btn_zax_update")],
    [sg.HSeperator()],
    [sg.Text("Auto scan for games", justification="c")],
    [
        sg.Button("Scan", key="btn_zax_scan", enable_events=True),
    ],
    [sg.HSeperator()],
    [sg.Text("Backup directory", justification="c")],
    [
        sg.Button("Open", key="zax-backup-open", enable_events=True),
        sg.Button("Wipe", key="zax-backup-wipe", enable_events=True),
    ],
    [sg.HSeperator()],
    [sg.Text("Debug archive directory", justification="c")],
    [
        sg.Button("Open", key="zax-debug-open", enable_events=True),
        sg.Button("Wipe", key="zax-debug-wipe", enable_events=True),
    ],
    [sg.HSeperator()],
    [sg.Text("Log file", justification="c")],
    [sg.Button("View", key="zax-log-view", enable_events=True)],
    [sg.HSeperator()],
    [sg.Text("Theme", justification="c")],
    [sg.Combo(["light", "dark"], readonly=True, key="dd_zax_theme", enable_events=True)],
    [sg.Button("Save and restart", key="btn_zax_theme_restart", enable_events=True)],
]
