# Fixtures

Real configuration files used by the test suite and the development preview.

`vanilla-f2up/` comes from a GOG install with the Fallout 2 Unofficial Patch applied. The `ddraw.ini` there is
sfall 3.3, which predates the `[Debugging]` and `[Interface]` sections that 4.x added - useful coverage for
settings whose section does not yet exist in a given install.

`fo2tweaks/` is FO2tweaks as it publishes itself - the `f2mod.yml` its repository carries and the
`mods/fo2tweaks.ini` its release ships. The preview seeds both, so the mod settings surface is exercised
against a real manifest rather than a sample written to fit it.

These are plain text configuration files, not game assets. Keep them byte-for-byte as they came off a real
install - the round-trip tests assert exact reproduction.
