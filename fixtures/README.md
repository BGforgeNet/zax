# Fixtures

Real configuration files used by the test suite and the development preview.

`vanilla-f2up/` comes from a GOG install with the Fallout 2 Unofficial Patch applied. The `ddraw.ini` there is
sfall 3.3, which predates the `[Debugging]` and `[Interface]` sections that 4.x added - useful coverage for
settings whose section does not yet exist in a given install.

These are plain text configuration files, not game assets. Keep them byte-for-byte as they came off a real
install: the round-trip tests assert exact reproduction, so reformatting them would defeat their purpose.
