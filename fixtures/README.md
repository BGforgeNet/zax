# Fixtures

Real configuration files used by the test suite and the development preview.

`f2up/` comes from a GOG install with the Fallout 2 Unofficial Patch applied. The `ddraw.ini` there is
sfall 3.3, which predates the `[Debugging]` and `[Interface]` sections that 4.x added - useful coverage for
settings whose section does not yet exist in a given install.

`fo2tweaks/mods/fo2tweaks.ini` is the ini FO2tweaks' release ships, verbatim. The `f2mod.yml` beside it is
not the mod's own: FO2tweaks publishes no manifest yet, so this one is written here against the real ini,
describing the settings that ini actually holds. The preview and the settings tests read both, which is what
keeps the surface honest about the mod even though the document is ours - but it is not evidence of what the
format looks like in the wild, and it moves when the mod's own arrives.

`manifests/` is the odd one out: not copies of anything but specimens written here, one per shape the mod
manifest format takes, each with a `.json` sibling holding what it must parse to. They are what makes the
format's append-only promise a test - a change that alters what an already-published manifest means fails one
of them. Their quoting and flow style are part of what is pinned, so leave both alone.

The rest are plain text configuration files, not game assets. Keep them byte-for-byte as they came off a real
install - the round-trip tests assert exact reproduction.
