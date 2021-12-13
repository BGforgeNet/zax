from PySide2.QtWidgets import QTreeWidgetItemIterator
import cssutils

# import PySimpleGUIQt as sg
from theme import sg
from PySimpleGUIQt.PySimpleGUIQt import DEFAULT_INPUT_ELEMENTS_COLOR

icon_folder = b"""
    iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsSAAALEgHS3X78AAABnUlEQVQ4y8WSv2rUQRSFv7vZgJFFsQg2EkWb4AvEJ8hq
    KVilSmFn3iNvIAp21oIW9haihBRKiqwElMVsIJjNrprsOr/5dyzml3UhEQIWHhjmcpn7zblw4B9lJ8Xag9mlmQb3AJzX3tOX8Tngzg349q7t5xcfzpKGhOFH
    njx+9qLTzW8wsmFTL2Gzk7Y2O/k9kCbtwUZbV+Zvo8Md3PALrjoiqsKSR9ljpAJpwOsNtlfXfRvoNU8Arr/NsVo0ry5z4dZN5hoGqEzYDChBOoKwS/vSq0XW
    3y5NAI/uN1cvLqzQur4MCpBGEEd1PQDfQ74HYR+LfeQOAOYAmgAmbly+dgfid5CHPIKqC74L8RDyGPIYy7+QQjFWa7ICsQ8SpB/IfcJSDVMAJUwJkYDMNOEP
    IBxA/gnuMyYPijXAI3lMse7FGnIKsIuqrxgRSeXOoYZUCI8pIKW/OHA7kD2YYcpAKgM5ABXk4qSsdJaDOMCsgTIYAlL5TQFTyUIZDmev0N/bnwqnylEBQS45
    UKnHx/lUlFvA3fo+jwR8ALb47/oNma38cuqiJ9AAAAAASUVORK5CYII=
"""
icon_file = b"""
    iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsSAAALEgHS3X78AAABU0lEQVQ4y52TzStEURiHn/ecc6XG54JSdlMkNhYWsiIL
    S0lsJaUsLW2Mv8CfIDtr2VtbY4GUEvmIZnKbZsY977Uwt2HcyW1+dTZvt6fn9557BGB+aaNQKBR2ifkbgWR+cX13ubO1svz++niVTA1ArDHDg91UahHFsMxb
    KWycYsjze4muTsP64vT43v7hSf/A0FgdjQPQWAmco68nB+T+SFSqNUQgcIbN1bn8Z3RwvL22MAvcu8TACFgrpMVZ4aUYcn77BMDkxGgemAGOHIBXxRjBWZMK
    oCPA2h6qEUSRR2MF6GxUUMUaIUgBCNTnAcm3H2G5YQfgvccYIXAtDH7FoKq/AaqKlbrBj2trFVXfBPAea4SOIIsBeN9kkCwxsNkAqRWy7+B7Z00G3xVc2wZe
    MSI4S7sVYkSk5Z/4PyBWROqvox3A28PN2cjUwinQC9QyckKALxj4kv2auK0xAAAAAElFTkSuQmCC
"""

SELECT_MODE_NONE = 0
SELECT_MODE_SINGLE = 1
SELECT_MODE_MULTIPLE = 2
SELECT_MODE_EXTENDED = 3
SELECT_MODE_CONTIGUOUS = 4


class ImageListBox:
    def __init__(
        self,
        values,
        headings=None,
        col_widths=None,
        col0_width=10,
        def_col_width=10,
        auto_size_columns=True,
        max_col_width=20,
        select_mode=None,
        enable_events=False,
        font=None,
        size=(200, 600),
        justification="center",
        text_color=None,
        background_color=None,
        num_rows=None,
        pad=None,
        key=None,
        tooltip=None,
        visible=True,
        size_px=(None, None),
        metadata=None,
        default_icon=None,
    ):
        self.values = values
        self.headings = headings
        self.col_widths = col_widths
        self.col0_width = col0_width
        self.def_col_width = def_col_width
        self.auto_size_columns = auto_size_columns
        self.max_col_width = max_col_width
        self.select_mode = select_mode
        self.enable_events = enable_events
        self.font = font
        self.size = size
        self.justification = justification
        self.text_color = text_color
        self.background_color = background_color if background_color else DEFAULT_INPUT_ELEMENTS_COLOR
        self.num_rows = num_rows
        self.pad = pad
        self.key = key
        self.tooltip = tooltip
        self.visible = visible
        self.size_px = size_px
        self.metadata = metadata
        self.default_icon = default_icon

        self.treedata = sg.TreeData()
        # values can be string "text" or list ["text", "icon"]
        i = 0
        for v in values:
            if type(v) is str:
                if self.default_icon is not None:
                    self.treedata.insert("", "{}-{}".format(self.key, i), v, [], icon=default_icon)
                else:
                    self.treedata.insert("", "{}-{}".format(self.key, i), v, [])
            else:
                self.treedata.insert("", "{}-{}".format(self.key, i), v[0], [], icon=v[1])
            i += 1

        self.element = sg.Tree(
            self.treedata,
            headings=self.headings,
            col_widths=self.col_widths,
            col0_width=self.col0_width,
            def_col_width=self.def_col_width,
            auto_size_columns=self.auto_size_columns,
            max_col_width=self.max_col_width,
            select_mode=self.select_mode,
            enable_events=self.enable_events,
            font=self.font,
            size=self.size,
            justification=self.justification,
            text_color=self.text_color,
            background_color=self.background_color,
            num_rows=self.num_rows,
            pad=self.pad,
            key=self.key,
            tooltip=self.tooltip,
            visible=self.visible,
            size_px=self.size_px,
            metadata=self.metadata,
        )

    def init_finalize(self, select_first=False):
        self.widget = self.element.Widget
        self.widget.setRootIsDecorated(False)
        self.set_tooltip_style()
        self.hide_header()
        if select_first:
            self.select_first()
        self.set_tooltips()

    def value(self, values):
        tree_values = values[self.key]
        ret = []
        for x in tree_values:
            key = "{}-{}".format(self.key, x)
            ret.append(self.treedata.tree_dict[key].text)
        return ret

    def select_first(self):
        first = QTreeWidgetItemIterator(self.widget).value()
        self.widget.setCurrentItem(first)

    # for some reason tooltips have no style, copying it from the tree
    def set_tooltip_style(self):
        w_style = self.widget.styleSheet()
        sheet = cssutils.parseString(w_style)
        rule = [r for r in sheet if (r.type == r.STYLE_RULE) and (r.selectorText == "QTreeWidget")][0]
        rs = rule.style
        style = "QToolTip {{ font-family: {}; font-size: {}; color: {}; background-color: {}; }}".format(
            rs["font-family"], rs["font-size"], rs["color"], rs["background-color"]
        )
        style = "{} {}".format(w_style, style)
        self.widget.setStyleSheet(style)

    def set_tooltips(self):
        it = QTreeWidgetItemIterator(self.widget)
        while it.value():
            row = it.value()
            text = row.text(0)
            if len(text) > (self.size[0] / 9):
                it.value().setToolTip(0, text)
            it += 1

    def hide_header(self):
        self.widget.setHeaderHidden(True)
