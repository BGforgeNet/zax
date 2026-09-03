# Base mods

A base mod transforms an install into a different game - RPU and UPU are the cases - so it installs on a vanilla
game, cannot be uninstalled, and does not describe what it does: it names the installer its release already
ships, and ZAX runs that.

```yaml
type: base
becomes: fallout2rpu
installer:
  windows:
    asset: rpu_v2.4.34.exe
    silent: inno
    components:
      - label: Walk speed fix
        pick: one
        options:
          - { id: core, label: Core, required: true }
          - { id: 'walk_speed\low_fps', label: Low FPS }
  other:
    asset: rpu_v2.4.34.zip
    run: rpu-install.sh
```

`becomes` names the game type the install reports afterwards and must be one ZAX can detect; it is what every
later gate reads. `needs.game` defaults to `[fallout2]` for a base mod rather than to every type.

The two routes are not the same install, which is why they are declared separately:

- **`windows`** names an installer program. `silent: inno` is the convention ZAX invokes it by, and the only one
  it knows today. ZAX passes the install directory to it, along with the components chosen.
- **`other`** names a payload and a script inside it. ZAX extracts the payload over the game directory and runs
  `run` there, which is exactly what the manual instructions say to do by hand.

**Components are the Windows route's alone**, because that is where they exist: RPU's build moves its optional
dats out of `mods/` for the Inno installer only, and the zip ships all of them. Each component's `id` is the
installer's own name for it, verbatim, and `required: true` marks one that is selected whatever the user picks -
Inno's component switch deselects everything it does not name.

An installer this version cannot run - a `silent` convention it does not know, a platform key it has no name
for - refuses as needing a newer ZAX rather than as a misspelling. Both decide what gets executed, so there is
nothing safe to assume about either.

Nothing about a base install is undone: there is no uninstall, and a failed one is reported with how far it got
and where the installer's own backup directory is, rather than unwound.

## Base mods that create an install

The other kind of base mod does not transform the install it is offered on: it creates a second one inside it,
with its own executable, its own `mods/` and its own config files. Fallout et tu is the case. There is no
installer to delegate to and none is needed - nothing is overlaid or moved aside - so the manifest states what
it creates instead, and ZAX performs it.

```yaml
type: base
becomes: fo1in2
archive: Fallout1in2.zip
creates:
  directory: Fallout1in2
inputs:
  - id: fallout1
    label: Your Fallout 1 folder
    help: The folder holding Fallout 1's MASTER.DAT.
    holds: master.dat
extract-dat:
  from: fallout1
  list: undat_files.txt
  into: data
```

A base manifest names `installer` or `creates`, never both and never neither. With `creates`, `becomes` names
the type the **created** install reports - the host stays exactly what it was - and `needs.game` goes back to
its default of any type, since nothing outside the created directory is written.

`creates.directory` is one folder of the install, and it is the confinement bound for everything this mod
writes: the payload's own entries are checked against it before anything is extracted, and a release that
carries an entry outside it is refused.

**An install of this kind is made once, and never upgraded.** Where one is already there, the mod is refused
rather than unpacked over it - and both readings of "already there" count: the directory inside this
installation, and an installation that is itself what `becomes` names, which is what a created install added to
the list is. The reason is that a manifest of this shape describes a fresh unpack and nothing else: there is no
upgrade for ZAX to perform, and laying a release over an install would put the release's defaults back over
everything in it. The way to a newer release is a fresh folder. An install that never finished is the one
exception: that directory is the same install part-way through, and resuming it continues rather than repeats
it.

Resuming is therefore the one write this route makes over files that are already there, and what belongs to the
user in a whole game is more than the three files ZAX's own tabs edit. Two kinds are held aside first, and they
are not interchangeable. **Settings** are merged key by key: the game's config files plus every `.ini` the
payload carries, derived from the payload rather than listed, since a mod that installs a game ships its own
directory of settings and a copy of that list would go stale against the release that adds one. The **load
order** (`mods/mods_order.txt`) is put back exactly as it was instead: it is a list of names rather than keys, so
a merge would find nothing of the user's in it and keep the release's copy.

Each entry of `inputs` is a folder ZAX asks the user for, checked by the file it `holds`. `extract-dat` unpacks
one input's archive into the created install: `from` names the input, `list` is the response file the payload
ships - one path per line, as the archive spells them - and `into` is where they land. Both paths are read
inside the created directory.

A list is written against one edition of the archive and run against whichever the user owns, so a path the
user's copy does not hold is skipped and named in the result rather than failing the extraction. How many are
missing decides nothing: 8.3 collision suffixes are assigned in archive order, so another edition renumbers
hundreds of them at once. What is checked before anything is downloaded is that the folder holds an archive the
tool can read at all.
