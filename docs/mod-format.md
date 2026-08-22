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
| `type`       | no               | `pluggable` (default) or `permanent`. A permanent mod is never offered removal.          |
| `reason`     | with `permanent` | Why it cannot be uninstalled. Shown before install as well as after.                     |
| `archive`    | unless sole      | The asset carrying the payload. Needed unless the release has one archive and no more.   |
| `install-on` | no               | Game types it installs on, e.g. `[fallout2rpu]`. Absent means any; gates first installs. |
| `requires`   | no               | `sfall: ">=4.4.5"`, the lowest sfall version it works with. ZAX's updater is the answer. |
| `state`      | no               | Files belonging to the user, merged across upgrades. Default: every payload `.ini`.      |
| `entries`    | no               | What the mod puts in `mods/`, as the loader names them; see below. Default: derived.     |
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
neither refuses as "needs a newer ZAX", since a control gated on nothing would render live and never take
effect. A gated control carries a link that sets what it waits on, following the chain where the controller is
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
over. `extra` is the one place ignorance is free, by contract.

## The id is forever

The id is the feed match, the settings-id prefix, the removal convention and the record key. Renaming it
publishes a different mod: existing installs would be offered a fresh install beside themselves rather than
an upgrade. Ids may not begin with `game`, `hires` or `sfall`, the catalog's own namespaces.

## Getting a feed to follow a mod

The feed list ships in ZAX's code and changes only with a ZAX release - installing a mod is trusting its
publisher, and the list is where that trust is granted. Add the repository and id to `MOD_FEEDS` in
`packages/games-fallout2/src/mod-feed.ts`. A mod that has to write outside `mods/` needs a second entry, in
`MOD_GRANTS` beside it, naming the directory and why nothing packable would do.
