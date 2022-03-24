import PySimpleGUIQt as sg
from zax.theme import TEXT_DISABLED_COLOR


def hide_tab(window: sg.Window, key: str):
    sg_widget = window[key].Widget
    qt_widget = window[key].ParentTabGroup.QT_QTabWidget
    index = qt_widget.indexOf(sg_widget)
    qt_widget.setTabVisible(index, False)


def show_tab(window: sg.Window, key: str):
    sg_widget = window[key].Widget
    qt_widget = window[key].ParentTabGroup.QT_QTabWidget
    index = qt_widget.indexOf(sg_widget)
    qt_widget.setTabVisible(index, True)


def disable_tab(window: sg.Window, key: str):
    sg_widget = window[key].Widget
    qt_widget = window[key].ParentTabGroup.QT_QTabWidget
    index = qt_widget.indexOf(sg_widget)
    # this should really be only called once on tab creation, but there's not simple way to do that
    qt_widget.tabBar().setStyleSheet("QTabBar::tab:disabled {{ color: {}; }}".format(TEXT_DISABLED_COLOR))
    qt_widget.setTabEnabled(index, False)


def enable_tab(window: sg.Window, key: str):
    sg_widget = window[key].Widget
    qt_widget = window[key].ParentTabGroup.QT_QTabWidget
    index = qt_widget.indexOf(sg_widget)
    qt_widget.setTabEnabled(index, True)
