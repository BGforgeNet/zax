"""
Reads the previous implementation's layout modules and emits the tab/frame/control tree as JSON.

Parsed rather than transcribed: the tree is several hundred controls across three files, and a hand-copied
version would differ from the original in ways nobody could spot by reading it.
"""

import ast
import json
import sys

CONTROLS = {"checkbox", "slider", "spin", "dropdown", "qinput", "radio"}


def const(node):
    return node.value if isinstance(node, ast.Constant) else None


def kwargs_of(call):
    return {k.arg: const(k.value) for k in call.keywords if k.arg}


def control(call, module):
    """A control call is (cfg, section, key); everything else about it lives in the YAML."""
    name = call.func.id
    args = [const(a) for a in call.args]
    if len(args) < 3:
        return None
    kw = kwargs_of(call)
    out = {"kind": name, "section": args[1], "key": args[2]}
    if kw.get("visible") is False:
        # Carried so a control the previous UI deliberately hid does not reappear here.
        out["hidden"] = True
    if kw.get("disabled") is True:
        out["disabled"] = True
    return out


def walk(node, module):
    """Flattens a layout list into controls and frames, skipping raw PySimpleGUI element rows."""
    out = []
    if isinstance(node, (ast.List, ast.Tuple)):
        for el in node.elts:
            out.extend(walk(el, module))
        return out
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        fn = node.func.id
        if fn == "frame":
            title = const(node.args[0]) if node.args else None
            return [{"kind": "frame", "title": title, "items": walk(node.args[1], module)}]
        if fn in CONTROLS:
            c = control(node, module)
            return [c] if c else []
        return []
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
        # A raw PySimpleGUI element. Only the ones carrying a widget key hold a setting - the resolution frame
        # is built this way, and skipping them would silently drop SCR_WIDTH and SCR_HEIGHT.
        kw = kwargs_of(node)
        key = kw.get("key")
        if not isinstance(key, str):
            return []
        parts = key.split("-")
        if len(parts) == 3 and parts[0] == module:
            return [{"kind": "raw", "element": node.func.attr, "section": parts[1], "key": parts[2]}]
        return [{"kind": "widget", "element": node.func.attr, "id": key}]
    if isinstance(node, ast.Name):
        # A layout list assembled earlier and referenced by name, e.g. f2_res's `resolution` frame.
        return [{"kind": "ref", "name": node.id}]
    return out


def module_tree(path, module):
    tree = ast.parse(open(path).read())
    assigns = {}
    tabs = []
    for stmt in tree.body:
        if not isinstance(stmt, ast.Assign):
            continue
        target = stmt.targets[0]
        if isinstance(target, ast.Name):
            assigns[target.id] = stmt.value
        # tabs["Main"] = [...]
        if (
            isinstance(target, ast.Subscript)
            and isinstance(target.value, ast.Name)
            and target.value.id == "tabs"
        ):
            tabs.append({"title": const(target.slice), "items": walk(stmt.value, module)})

    # Resolve the named layout fragments the tab lists pull in.
    def resolve(items):
        out = []
        for it in items:
            if it.get("kind") == "ref":
                node = assigns.get(it["name"])
                out.extend(resolve(walk(node, module)) if node is not None else [])
            elif it.get("kind") == "frame":
                out.append({**it, "items": resolve(it["items"])})
            else:
                out.append(it)
        return out

    return [{"title": t["title"], "items": resolve(t["items"])} for t in tabs]


FILES = [
    ("fallout2.cfg", "Game", "scripts/gen/py/fallout2_cfg.py"),
    ("f2_res.ini", "HiRes", "scripts/gen/py/f2_res_ini.py"),
    ("ddraw.ini", "Sfall", "scripts/gen/py/ddraw_ini.py"),
]

out = []
for ini, label, path in FILES:
    out.append({"file": ini, "label": label, "tabs": module_tree(path, ini)})

json.dump(out, open("scripts/gen/py-layout.json", "w"), indent=1)

def count(items):
    n = 0
    for it in items:
        n += count(it["items"]) if it["kind"] == "frame" else 1
    return n

for f in out:
    print(f"{f['label']:6} ({f['file']}) tabs={len(f['tabs'])}")
    for t in f["tabs"]:
        frames = [i["title"] for i in t["items"] if i["kind"] == "frame"]
        print(f"    {t['title']:14} controls={count(t['items']):3}  frames={frames}")
