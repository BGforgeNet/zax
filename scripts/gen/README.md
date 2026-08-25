# Catalog and layout generation

`packages/games-fallout2/src/catalog.ts` and `layout.ts` are generated modules. Their sources:

- `formats/*.yml` - the previous implementation's format definitions, copied verbatim from the `python` branch
  (`zax/formats/*.yml` there). They carry each setting's type, bounds, options, names and descriptions.
- `added.yml` - settings ZAX carries that the previous implementation never had, in the same shape and read
  after the format definitions. Hand-authored, so this is where a new setting goes; each one also needs a row
  in `gen-layout.mjs`'s `ADDED` table saying which tab and frame it joins, or `layout.test.ts` fails.
- `py/*.py` - the previous implementation's layout modules, not committed here; materialize them when the
  extraction step needs re-running: `git show python:zax/layouts/<name>.py > scripts/gen/py/<name>.py` for
  `fallout2_cfg`, `f2_res_ini` and `ddraw_ini`.
- `layout.json` / `py-layout.json` - the tab/frame/control trees extracted from those modules by `extract.mjs`
  and `extract-layout.py`. Committed so regeneration does not require materializing `py/*.py` first.
- `engines/<id>.json` - the settings each alternative engine's own source registers, read by
  `extract-engines.mjs` from a checkout of that project and committed with the commit they came from. Nothing
  in them is inferred from a key's name. What to call each of those settings, and which of them are not
  offered at all, is the hand-authored other half, in `engine-settings.mjs`.

Two kinds of input, and which a change belongs in is the first question to answer. `formats/`, `py/` and the
two extracted JSON trees are copies, held identical to their source; `added.yml` and the generators' own
tables are hand-authored. Never edit a copy - what makes them worth having is that a re-extraction stays a
comparison rather than a merge.

Run from the repo root, in this order (each later step reads the earlier one's output):

1. `node scripts/gen/extract.mjs` - only after changing `py/*.py`
2. `python3 scripts/gen/extract-layout.py` - same
3. `node scripts/gen/extract-engines.mjs <fallout2-ce|fission> <path to a checkout>` - only when following an
   engine to a newer commit, and it needs the network to obtain that checkout, which is why CI never runs it
4. `node scripts/gen/gen-catalog.mjs`
5. `node scripts/gen/gen-layout.mjs` - imports `gen-catalog.mjs` for the settings it places, so it runs last.
   Importing that module does not rewrite the catalog; only running it does.

To change how an existing setting is presented, edit the generators' hand-maintained tables - labels, help
rewrites, bounds, gates, conflicts. To add a setting neither config format defines for us, edit `added.yml`
and give it a row in `gen-layout.mjs`'s `ADDED`. Editing the generated modules directly is lost on the next
regeneration.

`gen-catalog.mjs`'s `BINDINGS` joins the addresses an alternative engine keeps the same value under. Each row
lists the nominated address first - the id is minted from it - then one address per engine, and every address
belongs to at most one row: a bound address must not also be a setting of its own, or one key would get two
rows that disagree. The generator refuses both mistakes rather than emitting them.

An engine's settings reach the interface two ways, and `engine-settings.mjs` holds both. A key no other
component has becomes a setting of its own, named there. A key an engine reads under a name something else
already has becomes a second address on that existing row - derived automatically where both sides spell the
key identically, and named in `ENGINE_BINDINGS` where they do not. `ENGINE_TABS` then says what to call the
engine's tabs; a section with no entry there fails generation rather than appearing under its raw name.

CI reruns steps 4 and 5 on every push and fails on any difference from the committed modules, so a hand edit of
generated output - or a generator change committed without its regeneration - cannot land quietly.
