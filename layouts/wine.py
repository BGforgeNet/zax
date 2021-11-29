import PySimpleGUIQt as sg
from .common import *

sg.theme('Dark Brown')

layout = [
  [sg.Text("Prefix"), sg.InputText("", key='wine_prefix', size=(350, None))],
  [sg.Text("Args"), sg.InputText("", key='wine_args', size=(350, None))]
]
