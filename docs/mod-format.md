# The mod manifest: `f2mod.yml`

What a mod release ships so ZAX can install it. This page is the spec;
`packages/games-fallout2/src/manifest.ts` is the reference implementation, and `pnpm check-manifest <file>`
(from a ZAX checkout) applies exactly these rules.

## Two ways to publish

**Commit the manifest** at the repository root with no `version` and no `archive`, and release by pushing a
tag. The tag names the version - `v14.7` is 14.7, a tag shaped like anything else is passed over - and the
release's sole archive asset is the payload. There is nothing per-release to maintain, and the
`actions/pack-mod` action in this repository packs the archive for you.

**Or publish the manifest as an asset**, stamped by CI with both fields. The payload must then carry a
byte-identical copy at its root, which ZAX compares before installing: a difference of one line ending
refuses. Necessary where one repository publishes several mods, or a release carries several archives.

Either way:

- **The payload** is a release asset. Where it is an archive, everything under `mods/` is deployed and
  everything else ignored; a payload with nothing there installs nothing. Its SHA-256 (GitHub publishes one
  per asset) is required, and a download that does not match is discarded.
- **A payload that is not an archive** is one file, deployed as it stands to the single `entries` name the
  manifest declares - Cassidy's four `.dat` assets and the walk-speed fix's one are published that way. It
  has to be named by `archive`, because inference stays archive-only: a release of loose files carries
  nothing that tells the payload from the rest of it.
- Archives are checked before extraction: symlink entries, over 10,000 entries, paths deeper than 16
  segments, or over 8 GiB unpacked all refuse.

## The manifest

Four lines are a manifest, when a tag supplies the version and one asset is the payload:

```yaml
spec: 1
id: fo2tweaks
name: FO2tweaks
game: fallout2
```

| Field        | Required         | Meaning                                                                                  |
| ------------ | ---------------- | ---------------------------------------------------------------------------------------- |
| `spec`       | yes              | Format version, currently `1`. An earlier one reads; a later needs a newer ZAX.          |
| `id`         | yes              | Permanent identity: lowercase `a-z0-9.-`. See "The id is forever".                       |
| `name`       | yes              | Display name.                                                                            |
| `version`    | unless tagged    | Digit-led. Quote it - YAML reads `14.7` as a number, and the literal wins.               |
| `game`       | yes              | `fallout2`. Anything else refuses.                                                       |
| `type`       | no               | `pluggable` (default), `permanent` or `base`. See "Base mods".                           |
| `reason`     | with `permanent` | Why it cannot be uninstalled. Shown before install as well as after.                     |
| `archive`    | unless sole      | The asset carrying the payload. Needed unless the release has one archive and no more.   |
| `install-on` | no               | Game types it installs on, e.g. `[fallout2rpu]`. Absent means any; gates first installs. |
| `requires`   | no               | `sfall: ">=4.4.5"`, the lowest sfall version it works with. ZAX's updater is the answer. |
| `state`      | no               | Files belonging to the user, merged across upgrades. Default: every payload `.ini`.      |
| `entries`    | no               | What the mod puts in `mods/`, as the loader names them; see below. Default: derived.     |
| `parts`      | no               | Choices the release offers, each naming its own asset; see below. Excludes `archive`.    |
| `becomes`    | with `base`      | The game type the install reports afterwards, e.g. `fallout2rpu`.                        |
| `installer`  | with `base`      | The installer to run, per platform; see "Base mods".                                     |
| `refuse`     | no               | When installing refuses; see below.                                                      |
| `settings`   | no               | The settings schema; see below.                                                          |
| `extra`      | no               | Ignored by contract - where an author's or a tool's own data may ride along.             |

Parsing is strict: an unknown field refuses the manifest, so a misspelling cannot silently drop a safety rule
(`extra` is the escape hatch). UTF-8, at most 256 KB; text fields cap at 200 characters, 1000 for help and
reasons, and may not hold control characters. Path-shaped fields are confined - absolute paths, drive
letters, `..`, or anything outside `mods/` refuse the manifest whole. A few named mods are granted one
directory beyond it, where the engine reads that directory from the filesystem and no archive can stand in
for it. The grant is ZAX's to give and not something a manifest can claim: declaring the path is how a mod
says where it writes, never how it gets permission.

### What the mod puts in `mods/`

sfall loads only what `mods/mods_order.txt` names, files and folders alike, so every mod needs a line there.
By default ZAX derives one per top-level `.dat` the payload ships, which is right for a mod that is a single
archive file and wrong for two shapes:

- **A mod whose entry is a folder.** Inventory Filter deploys `mods/InventoryFilter.dat/`, a _directory_ that
  is named `*.dat`. Its payload paths all sit below that name, so nothing derived from them names the entry -
  the mod installs, reports success, and is never loaded.
- **A nested entry.** `mods/patches/extra.dat` reads either as a folder entry `patches` or as a dat at a path
  below it. Both are valid to the loader, and only the mod knows which it meant.

Declare them instead, relative to `mods/`, and they become the order file's lines verbatim:

```yaml
entries: [InventoryFilter.dat]
```

The list is also what ZAX matches when deciding whether the mod is already installed, which is the only thing
that answers for a payload filename an id cannot reach - an id carries no underscore and `cassidy_head.dat`
does. A mod deploying more than one file names each: Cassidy's head and its voice are two entries.

An entry the payload does not carry refuses the install, rather than writing a line naming something absent.
A payload that is not an archive declares exactly one: a single file has no paths of its own, so this is the
only thing that can say what it installs as.

### Parts

A release that publishes several payloads and asks which of them to install - HQ music's four packages,
Cassidy's head and its three voices - declares them as groups of options:

```yaml
parts:
  - label: Head
    pick: any
    options:
      - id: head
        label: Cassidy's new head
        archive: cassidy_head.dat
        entries: [cassidy_head.dat]
  - label: Voice
    pick: one
    options:
      - id: voice-joey
        label: Joey Bracken
        help: The voice from the original release.
        archive: cassidy_voice_joey_bracken_hq.dat
        entries: [cassidy_voice_joey_bracken_hq.dat]
        needs: head
```

`pick: one` takes at most one of the group - a group may end with nothing chosen - and `pick: any` makes each
option independently on or off. Every part names its own release asset, an archive or a single file as the
payload rules above have it, and its own `entries`; a manifest with `parts` states no top-level `archive`. A
part may name one other part it `needs`, in any group, and is not offered while that one is unselected. Groups
and options are shown in the order the manifest declares them.

**A part id is as permanent as the mod's.** The install records which parts were chosen, and the next release
is matched against that record by id: a renamed part reads as one part removed and another added, so the user
loses the choice they made. A part the release stops offering is dropped, with the upgrade saying so; a part
newly offered starts off; a `one` group whose choice is gone puts the question back to the user.

A group asking for something ZAX does not implement - any `pick` beyond these two - refuses as needing a newer
ZAX. Unlike a settings entry, what a group picks decides what lands on disk, so there is nothing safe to
assume about one that cannot be read.

### Base mods

A base mod transforms an install into a different game - RPU and UPU are the cases - so it installs on a
vanilla game, cannot be uninstalled, and does not describe what it does: it names the installer its release
already ships, and ZAX runs that.

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
          - { id: "walk_speed\low_fps", label: Low FPS }
  other:
    asset: rpu_v2.4.34.zip
    run: rpu-install.sh
```

`becomes` names the game type the install reports afterwards and must be one ZAX can detect; it is what every
later gate reads. `install-on` defaults to `[fallout2]` for a base mod rather than to every type.

The two routes are not the same install, which is why they are declared separately:

- **`windows`** names an installer program. `silent: inno` is the convention ZAX invokes it by, and the only
  one it knows today. ZAX passes the install directory to it, along with the components chosen.
- **`other`** names a payload and a script inside it. ZAX extracts the payload over the game directory and
  runs `run` there, which is exactly what the manual instructions say to do by hand.

**Components are the Windows route's alone**, because that is where they exist: RPU's build moves its optional
dats out of `mods/` for the Inno installer only, and the zip ships all of them. Each component's `id` is the
installer's own name for it, verbatim, and `required: true` marks one that is selected whatever the user
picks - Inno's component switch deselects everything it does not name.

An installer this version cannot run - a `silent` convention it does not know, a platform key it has no name
for - refuses as needing a newer ZAX rather than as a misspelling. Both decide what gets executed, so there is
nothing safe to assume about either.

Nothing about a base install is undone: there is no uninstall, and a failed one is reported with how far it
got and where the installer's own backup directory is, rather than unwound.

### Refusal rules

```yaml
refuse:
  - when: { present: [mods/other.dat], absent: [mods/compat.ini] }
    reason: Not alongside Other without its compatibility patch.
```

A rule fires when every `present` path exists and every `absent` path does not, judged against the install
directory at install time, case-insensitively as the engine treats paths. The reason is shown verbatim, so
write it as a sentence.

### Settings

```yaml
settings:
  main.autodoors:
    kind: choice
    options:
      - { value: 0, label: "Off" }
      - { value: 1, label: "Open" }
    default: 1
    label: Automatic doors
    help: Walk through unlocked doors without clicking, outside combat.
  run_speed.dude:
    kind: bool
    default: 1
    label: The Chosen One
    gated-by: { id: sfall.Misc.DamageFormula, is: [0] }
```

A flat mapping keyed by the entry's real address in the ini, `section.key`, split at the first dot - a
section name cannot contain a dot, a key can. An entry may name its `file` (under `mods/`, default
`mods/<id>.ini`) and carries a `kind` with that kind's fields:

| Kind           | Fields                              | Renders as                                     |
| -------------- | ----------------------------------- | ---------------------------------------------- |
| `bool`         | `on`, `off` (default `1`/`0`)       | a toggle                                       |
| `choice`       | `options` of `value`/`label`/`help` | a dropdown                                     |
| `int`, `float` | `min`, `max`, `unit`, `sentinels`   | a number field; sentinels label special values |
| `scale`        | `max`                               | a slider from 0                                |
| `text`         | `path` (boolean)                    | a text field                                   |
| `key`          | -                                   | a key-code field                               |

A setting's id is the mod's id plus the address verbatim (`fo2tweaks.main.autodoors`), the rule ZAX's own
catalog uses, so `gated-by` addresses a sibling entry or a catalog setting with no transform. A gate naming
neither drops that control - and whatever was gated on it in turn - rather than refusing the mod, since a
control gated on nothing would render live and never take effect. A `kind` this version does not implement
goes the same way. The mod still installs, and ZAX says how many controls it left out and which: a settings
entry only ever edits a key in the mod's own ini, where the release ships its own default, so one ZAX cannot
draw costs a knob rather than correctness. Which settings a version knows changes with every ZAX release, and
a mod must not become uninstallable for having sat on the wrong side of one. A gated control carries a link
that sets what it waits on, following the chain where the controller is
gated in turn, so list `is` values in the order you would recommend them - the first is the one that link
writes. A partial schema is fine, and a mod without one simply has no settings surface.

## How ZAX chooses a release

A feed entry names a repository and the id it follows. Of the releases whose manifest carries that id, ZAX
takes the highest manifest `version` - not the newest by date, so a hotfix on an older line does not shadow
the current one. It reads the hundred most recent releases, which is as many as one request may ask for; past
that, a hotfix to a line that old is not seen. Two ids may share a repository. A manifest that refuses to
parse is reported rather than skipped: when no release matches, the first refusal is the answer.

## Installing, upgrading, removing

- **Recorded per install**: version, deployed files, the manifest, and the `state` files as shipped.
- **Upgrade replaces, never overlays.** Files the new release drops are backed up and removed, top-level
  `.dat`s are enabled in the load order, and each state file merges with the user's changes winning over new
  defaults - the previously shipped copy tells the two apart.
- **Removal** deletes exactly the recorded files, copies first going to a timestamped backup.
- **Installed by hand** (present, no record): offered the current release laid over it, removed by the
  `mods/<id>.*` convention.
- **No longer followed** by the feed list: stays listed, with a note that updates will not be offered.
  Removal still works from the record.

## How the format changes

The `spec` number is a floor rather than a pin. ZAX reads any manifest written to the spec it implements or to
an earlier one, and refuses only one asking for more than it has. That is safe because the format is
append-only within a spec major: fields are added, a field's meaning never changes, and a retired field stays
parsed and ignored for a major before it goes. So adding an operator is a new field, changing one is a new
field plus a retirement, and only a removal needs a new major.

What ZAX does with something it does not recognise follows from what ignoring it would cost. A field that
decides what lands on disk - `entries`, `state`, `install-on`, `type`, `refuse` - refuses the manifest, because
ignoring it would write the wrong thing; that is why an unknown field refuses at all rather than being passed
over. Inside `settings` the cost is a control rather than a file, so an entry ZAX cannot draw is dropped and
named instead. `extra` is the one place ignorance is free outright, by contract.

## The id is forever

The id is the feed match, the settings-id prefix, the removal convention and the record key. Renaming it
publishes a different mod: existing installs would be offered a fresh install beside themselves rather than
an upgrade. Ids may not begin with `game`, `hires` or `sfall`, the catalog's own namespaces.
Part ids are forever for the same reason and in the same way, as _Parts_ above spells out.

## Getting a feed to follow a mod

The feed list ships in ZAX's code and changes only with a ZAX release - installing a mod is trusting its
publisher, and the list is where that trust is granted. Add the repository and id to `MOD_FEEDS` in
`packages/games-fallout2/src/mod-feed.ts`. A mod that has to write outside `mods/` needs a second entry, in
`MOD_GRANTS` beside it, naming the directory and why nothing packable would do.
