# Catalog and layout generation

`packages/games-fallout2/src/catalog.ts` and `layout.ts` are generated modules. Their sources:

- `formats/*.yml` - the previous implementation's format definitions, copied verbatim from the `python` branch
  (`zax/formats/*.yml` there). They carry each setting's type, bounds, options, names and descriptions.
- `py/*.py` - the previous implementation's layout modules, not committed here; materialize them when the
  extraction step needs re-running: `git show python:zax/layouts/<name>.py > scripts/gen/py/<name>.py` for
  `fallout2_cfg`, `f2_res_ini` and `ddraw_ini`.
- `layout.json` / `py-layout.json` - the tab/frame/control trees extracted from those modules by `extract.mjs`
  and `extract-layout.py`. Committed so regeneration does not require materializing `py/*.py` first.

Run from the repo root, in this order (each later step reads the earlier one's output):

1. `node scripts/gen/extract.mjs` - only after changing `py/*.py`
2. `python3 scripts/gen/extract-layout.py` - same
3. `node scripts/gen/gen-catalog.mjs`
4. `node scripts/gen/gen-layout.mjs` - reads the generated catalog, so it runs last

The generators' hand-maintained tables (labels, help rewrites, bounds, gates, conflicts) are the place to change
a setting's presentation; editing the generated modules directly is lost on the next regeneration.
