## Development

ZAX is based on PySimpleGUIQT and uses PyInstaller for packaging. Help is welcome.

### Getting started

#### Option 1: [Poetry](https://python-poetry.org/docs/):
```bash
poetry install
poetry shell
python -m zax
```

#### Option 2: pip/virtualenv
```bash
virtualenv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
```

### Requirements
Requirements are managed in `pyproject.toml` with Poetry. `requirements[-dev].txt` are generated automatically for backwards compatibility and should not be changed manually.
