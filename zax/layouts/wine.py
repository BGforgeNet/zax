from zax.theme import sg

layout = [
    [sg.Text("WINEPREFIX"), sg.InputText("", key="wine_prefix", size=(350, None))],
    [sg.Text("WINEDEBUG"), sg.InputText("", key="wine_debug", size=(350, None))],
]
