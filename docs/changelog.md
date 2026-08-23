# Changelog

### 0.8.0

Rewritten. ZAX is now a desktop application rather than a Python program run from a terminal, and it manages
mods as well as settings.

- **Every setting in one place.** `fallout2.cfg`, `f2_res.ini` and sfall's `ddraw.ini` are edited through one
  interface, with each setting shown as the control it deserves - a toggle, a dropdown, a slider, a key. A
  setting that depends on another says so and greys out until that one is right, and two that contradict each
  other say which. Search covers all three files at once and takes you to where a setting lives.
- **Keys the catalog does not describe still appear**, read from the file with their own comments as help, so
  a component newer than this release is editable rather than invisible.
- **Your files are edited, not rewritten.** Comments, spacing, ordering and line endings survive: changing one
  setting rewrites one line. Every file a save is about to write is copied to a backup directory first.
- **Mods.** Install, upgrade and remove mods published as releases, with their settings edited like the game's
  own. Upgrades keep the changes you made to a mod's ini rather than overwriting them, an interrupted install
  can be resumed or put back exactly, and removal deletes only what was recorded as installed.
- **Big mods too.** Restoration Project and the Unofficial Patch install through their own installers, with the
  components they offer chosen in ZAX on Windows. Fallout et tu builds a second game beside this one out of
  your own copy of Fallout 1, and joins the game list when it is done.
- **What a release offers is asked before it downloads.** A mod publishing variants or add-ons asks which you
  want, and carries the answer to the next upgrade.
- **Load order.** Reorder and enable mods, see which installed mod each entry belongs to, sort to a
  recommended order, and forget entries whose files are gone.
- **sfall updates.** See the installed version, update to the latest or to a version you pick, and keep your
  `ddraw.ini` settings - the release's own defaults are merged in, so new keys arrive and your choices stay.
- **Bug reports in one archive.** Configs, the game's logs, listings of the folder and of `mods/`, the load
  order, ZAX's own log, and any savegames you choose.
- **Runs from anywhere.** Windows, Linux and macOS builds, none of them installers. A `data` directory beside
  the executable makes a copy portable, settings and all.
- **Try it without a game.** Opened in a browser, the interface edits a bundled fixture; anything that would
  reach the network or start a program says so instead of pretending.

Earlier releases were the Python implementation, and are on the
[releases page](https://github.com/BGforgeNet/zax/releases).

### 0.7

Maintenance release, dependencies updates.

### 0.6

Fixed ZAX displayed version.

### 0.5

- Fixed Troubleshooting tab not updating on game switch.
- Published to PyPi.

### 0.4

- Disabled tabs when there's no games or configs are missing.

### 0.3

- Fixed window icons.
- Added game type detection, icons to game list.

### 0.2

Added theme selector.

### 0.1

Initial release.
