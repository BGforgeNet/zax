# The mod manifest: `f2mod.yml`

A mod release tells ZAX what it is by shipping a manifest. This page is the format's specification for mod
authors and their release CI; the parser at `packages/games-fallout2/src/manifest.ts` is the reference
implementation, and `pnpm check-manifest path/to/f2mod.yml` (from a ZAX checkout) validates a file with
exactly the rules described here.

## What a release carries

- **Two byte-identical copies of the manifest**: one as a standalone release asset named `f2mod.yml`, one at
  the root of the payload archive. ZAX reads the asset to list and judge the release without downloading the
  payload, then compares the embedded copy byte for byte before installing - a difference means the archive is
  not the release the manifest described, and the install refuses. Write both from one source in CI; a
  hand-edited copy that differs by a line ending is a refused install.
- **The payload archive**, named by the manifest's `archive` field. Everything it ships under `mods/` is
  deployed; entries elsewhere (a readme, manual-install notes) are ignored, and a release with nothing under
  `mods/` has nothing to install. The archive's stated SHA-256 digest (GitHub attaches one to every uploaded
  asset) is required - a download that does not match it is discarded.
- Archives are inspected before extraction: symbolic-link entries, more than 10,000 entries, paths nested
  deeper than 16 segments, or more than 8 GiB declared unpacked are refused outright.

## The manifest

The smallest valid manifest is five lines; a release adds `archive` to be installable:

```yaml
spec: 1
id: fo2tweaks
name: FO2tweaks
version: "14.7"
game: fallout2
archive: fo2tweaks.zip
```

| Field        | Required         | Meaning                                                                                               |
| ------------ | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `spec`       | yes              | Format version, currently `1`. A later spec makes ZAX say "needs a newer ZAX" rather than guess.      |
| `id`         | yes              | The mod's permanent identity: lowercase `a-z0-9.-`. See "The id is forever" below.                    |
| `name`       | yes              | Display name, shown everywhere in the interface.                                                      |
| `version`    | yes              | A digit-led version string. Quote it - YAML reads `14.7` as a number, and the file's literal wins.    |
| `game`       | yes              | `fallout2`. Anything else refuses.                                                                    |
| `type`       | no               | `pluggable` (default) or `permanent`. A permanent mod is never offered removal.                       |
| `reason`     | with `permanent` | Why the mod cannot be uninstalled. Shown before install as well as after.                             |
| `archive`    | no               | The release asset carrying the payload - a bare file name. Without it the release is not installable. |
| `install-on` | no               | Game types the mod installs on, e.g. `[fallout2rpu]`. Absent means any. Gates first installs only.    |
| `requires`   | no               | `sfall: ">=4.4.5"` - the lowest sfall version the mod works with. ZAX's updater is the answer.        |
| `state`      | no               | Files that belong to the user and survive upgrades by merging. Default: every payload `.ini`.         |
| `refuse`     | no               | Conditions under which installing refuses; see below.                                                 |
| `settings`   | no               | The mod's settings schema; see below.                                                                 |
| `extra`      | no               | Ignored by contract - the one place an author's or a tool's own data may ride along.                  |

Parsing is strict on purpose: an unknown field refuses the manifest, so a misspelling cannot silently drop a
safety rule (`extra` is the designated escape hatch). Files must be UTF-8, at most 256 KB; text fields are
capped (200 characters, 1000 for help and reasons) and may not contain control characters. Every path-shaped
field is confined - absolute paths, drive letters, `..`, and anything outside `mods/` refuse the manifest
whole.

### Refusal rules

```yaml
refuse:
  - when: { present: [mods/other.dat], absent: [mods/compat.ini] }
    reason: Not alongside Other without its compatibility patch.
```

A rule fires when every `present` path exists and every `absent` path does not, judged against the install
directory at install time, case-insensitively - the way the engine treats paths. The reason is shown to the
user verbatim, so write it as a sentence.

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

Settings are a flat mapping keyed by the entry's real address in the ini, `section.key`, split at the first
dot - so a section name cannot contain a dot, a key can. Each entry may name its `file` (under `mods/`;
default `mods/<id>.ini`) and carries a `kind` with that kind's own fields:

| Kind           | Fields                              | Renders as                                     |
| -------------- | ----------------------------------- | ---------------------------------------------- |
| `bool`         | `on`, `off` (default `1`/`0`)       | a toggle                                       |
| `choice`       | `options` of `value`/`label`/`help` | a dropdown                                     |
| `int`, `float` | `min`, `max`, `unit`, `sentinels`   | a number field; sentinels label special values |
| `scale`        | `max`                               | a slider from 0                                |
| `text`         | `path` (boolean)                    | a text field                                   |
| `key`          | -                                   | a key-code field                               |

A setting's id is the mod's id plus the address, verbatim (`fo2tweaks.main.autodoors`) - the same rule ZAX's
own catalog uses - so `gated-by` may name a sibling entry or one of ZAX's catalog settings with no transform.
A gate whose target neither the schema nor the catalog knows refuses as "needs a newer ZAX": a control gated
on nothing would render live and silently never take effect. The schema may be partial; the interface keeps
the mod's own files reachable for whatever it leaves out, and a mod with no schema simply has no settings
surface.

## How ZAX chooses a release

A feed entry names a repository and the id it follows. ZAX reads the repository's releases and takes, of
every release whose manifest carries the followed id, the one with the highest manifest `version` - not the
newest by publication date, so a hotfix backported to an older line does not shadow the current one. Two ids
may share one repository; each feed picks its own releases out of the shared stream. A manifest that refuses
to parse is reported rather than skipped silently: when no release matches, the first refusal is the answer.

## Installing, upgrading, removing

ZAX records what it installs - version, deployed files, the manifest, and the `state` files exactly as the
release shipped them. On upgrade, files the new release no longer ships are backed up and removed (an upgrade
replaces, never overlays), the payload's top-level `.dat`s are enabled in the load order, and each state file
is merged: the user's changes win over the release's new defaults, with the previously shipped copy telling
the two apart. Removal deletes exactly the recorded files, copies first going to a timestamped backup. A mod
installed by hand - present with no record - is offered the current release laid over it, and removed by the
`mods/<id>.*` convention.

If the feed list ever stops following an installed mod's id, the mod stays listed as installed with a note
that updates will no longer be offered; removal keeps working from the record.

## The id is forever

The id is the mod's identity: the feed match, the settings-id prefix, the removal convention, the record key.
Renaming it is publishing a different mod - existing installs would be offered a fresh install beside
themselves rather than an upgrade. Pick it once and keep it. Ids may not begin with `game`, `hires` or
`sfall`, which are the catalog's own namespaces.

## Getting a feed to follow a mod

The feed list ships in ZAX's code and changes only with a ZAX release - installing a mod is trusting its
publisher, and the list is where that trust is granted. Adding a mod means adding its repository and id to
`MOD_FEEDS` in `packages/games-fallout2/src/mod-feed.ts`.
