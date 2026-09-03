# Fields

Every field a manifest may carry. [The landing page](../mod-format.md) has the four that make one.

| Field         | Required         | Meaning                                                                                |
| ------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `spec`        | yes              | Format version, currently `1`. An earlier one reads; a later needs a newer ZAX.        |
| `id`          | yes              | Permanent identity: lowercase `a-z0-9.-`. See "The id is forever".                     |
| `name`        | yes              | Display name.                                                                          |
| `version`     | unless tagged    | Digit-led. Quote it - YAML reads `14.7` as a number, and the literal wins.             |
| `game`        | yes              | `fallout2`. Anything else refuses.                                                     |
| `type`        | no               | `pluggable` (default), `permanent` or `base`. See [Base mods](base-mods.md).           |
| `reason`      | with `permanent` | Why it cannot be uninstalled. Shown before install as well as after.                   |
| `archive`     | unless sole      | The asset carrying the payload. Needed unless the release has one archive and no more. |
| `needs`       | no               | What the mod needs of the install it lands on; see below.                              |
| `entries`     | no               | What the mod puts in `mods/`, as the loader names them; see below. Default: derived.   |
| `parts`       | no               | Choices the release offers, each naming its own asset. Excludes `archive`.             |
| `becomes`     | with `base`      | The game type the install reports afterwards, e.g. `fallout2rpu`.                      |
| `installer`   | one of the two   | The installer to run, per platform.                                                    |
| `creates`     | one of the two   | The install this one makes beside the host.                                            |
| `inputs`      | with `creates`   | What ZAX asks the user for before installing, each with the file that checks it.       |
| `extract-dat` | with `creates`   | An archive out of one of those inputs, unpacked into the created install.              |
| `conflicts`   | no               | When installing refuses; see below.                                                    |
| `settings`    | no               | The settings schema; see [Settings](settings.md).                                      |

## What the release supplies

A committed manifest states neither its version nor its payload's name. The tag supplies the version, and the
release's sole archive-shaped asset supplies the payload. Two archives on one release is an ambiguity only the
author can settle, so `archive` names one; a release of loose files needs it too, since nothing there tells the
payload from the rest of what is published.

**A payload that is not an archive** is one file, deployed as it stands to the single `entries` name the
manifest declares - Cassidy's four `.dat` assets and the walk-speed fix's one are published that way. It has to
be named by `archive`, because inference stays archive-only.

Archives are checked before extraction: symlink entries, over 10,000 entries, paths deeper than 16 segments, or
over 8 GiB unpacked all refuse.

## What the mod needs of the install

```yaml
needs:
  game: [fallout2rpu]
  sfall: "4.4.5"
```

`game` lists the game types the mod installs on, gating first installs; absent means any, and a base mod that
delegates to an installer defaults to vanilla alone. `sfall` is the lowest version the mod works with, read as
"this or newer" - a bare version rather than a bound, since a ceiling or an exact pin is nothing ZAX acts on.
An install below it is told so, with ZAX's own sfall updater named as the answer.

## What the mod puts in `mods/`

sfall loads only what `mods/mods_order.txt` names, files and folders alike, so every mod needs a line there. By
default ZAX derives one per top-level `.dat` the payload ships, which is right for a mod that is a single
archive file and wrong for two shapes:

- **A mod whose entry is a folder.** Inventory Filter deploys `mods/InventoryFilter.dat/`, a _directory_ that is
  named `*.dat`. Its payload paths all sit below that name, so nothing derived from them names the entry - the
  mod installs, reports success, and is never loaded.
- **A nested entry.** `mods/patches/extra.dat` reads either as a folder entry `patches` or as a dat at a path
  below it. Both are valid to the loader, and only the mod knows which it meant.

Declare them instead, relative to `mods/`, and they become the order file's lines verbatim:

```yaml
entries: [InventoryFilter.dat]
```

The list is also what ZAX matches when deciding whether the mod is already installed, which is the only thing
that answers for a payload filename an id cannot reach - an id carries no underscore and `cassidy_head.dat`
does. A mod deploying more than one file names each: Cassidy's head and its voice are two entries.

An entry the payload does not carry refuses the install, rather than writing a line naming something absent. A
payload that is not an archive declares exactly one: a single file has no paths of its own, so this is the only
thing that can say what it installs as.

## Conflicts

```yaml
conflicts:
  - when: { present: [mods/other.dat], absent: [mods/compat.ini] }
    reason: Not alongside Other without its compatibility patch.
```

A rule fires when every `present` path exists and every `absent` path does not, judged against the install
directory at install time, case-insensitively as the engine treats paths. The reason is shown verbatim, so write
it as a sentence.

These are the clashes ZAX cannot see for itself. Two mods writing the same file refuse without a rule, and files
your install already holds are shown as overwrites before anything is confirmed; a rule is for an
incompatibility with no file in common.

## What parsing refuses

Parsing is strict: an unknown field refuses the manifest, so a misspelling cannot silently drop a safety rule.
UTF-8, at most 256 KB; text fields cap at 200 characters, 1000 for help and reasons, and may not hold control
characters. Path-shaped fields are confined - absolute paths, drive letters, `..`, or anything outside `mods/`
refuse the manifest whole. A few named mods are granted one directory beyond it, where the engine reads that
directory from the filesystem and no archive can stand in for it. The grant is ZAX's to give and not something a
manifest can claim: declaring the path is how a mod says where it writes, never how it gets permission.

## How the format changes

The `spec` number is a floor rather than a pin. ZAX reads any manifest written to the spec it implements or to
an earlier one, and refuses only one asking for more than it has. That is safe because the format is
append-only within a spec major: fields are added, a field's meaning never changes, and a retired field stays
parsed and ignored for a major before it goes. So adding an operator is a new field, changing one is a new field
plus a retirement, and only a removal needs a new major.

What ZAX does with something it does not recognise follows from what ignoring it would cost. A field that
decides what lands on disk - `entries`, `needs`, `type`, `conflicts` - refuses the manifest, because ignoring it
would write the wrong thing; that is why an unknown field refuses at all rather than being passed over. Inside
`settings` the cost is a control rather than a file, so an entry ZAX cannot draw is dropped and named instead.
