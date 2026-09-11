# Fields

Every field a manifest may carry. [The landing page](../mod-format.md) has the four that make one.

Keys are flat. Where a field used to nest, the dot is part of the key itself: a manifest writes
`needs.sfall: "4.4.5"` at the top level, never a `needs:` mapping with `sfall` inside it. `settings` is the one
exception, since its nesting is the schema an author writes rather than a wrapper around two values.

| Field                          | Required           | Meaning                                                                                |
| ------------------------------ | ------------------ | -------------------------------------------------------------------------------------- |
| `spec`                         | yes                | Format version, currently `1`. An earlier one reads; a later needs a newer ZAX.        |
| `id`                           | yes                | Permanent identity: lowercase `a-z0-9.-`. See "The id is forever".                     |
| `name`                         | yes                | Display name.                                                                          |
| `version`                      | unless tagged      | Digit-led. Quote it - YAML reads `14.7` as a number, and the literal wins.             |
| `author`                       | no                 | Who wrote it, shown beside the name.                                                   |
| `description`                  | no                 | A sentence or two on what the mod is, shown on its row.                                |
| `forum`                        | no                 | Where the mod is discussed: an `https` address ZAX offers to open; see below.          |
| `homepage`                     | no                 | The same, for the mod's own site.                                                      |
| `game`                         | yes                | `fallout2`. Anything else refuses.                                                     |
| `type`                         | no                 | `pluggable` (default), `permanent` or `base`. See [Base mods](base-mods.md).           |
| `reason`                       | with `permanent`   | Why it cannot be uninstalled. Shown before install as well as after.                   |
| `archive`                      | unless sole        | The asset carrying the payload. Needed unless the release has one archive and no more. |
| `needs.game`                   | no                 | The game types it installs on; see below. Absent means any.                            |
| `needs.sfall`                  | no                 | The lowest sfall version it works with, read as "this or newer".                       |
| `entries`                      | no                 | What the mod puts in `mods/`, as the loader names them; see below. Default: derived.   |
| `order.overrides`              | no                 | Entries its files win over, as entries rather than ids; see below.                     |
| `order.overridden-by`          | no                 | Entries that win over its files.                                                       |
| `part-groups`                  | with `parts`       | The choices offered, each with an id, a label and a `pick`; see [Parts](parts.md).     |
| `parts`                        | with `part-groups` | The options, each naming its `group` and its own asset. Excludes `archive`.            |
| `becomes`                      | with `base`        | The game type the install reports afterwards, e.g. `fallout2rpu`.                      |
| `installer.windows.built-with` | one of the two     | The toolkit that produced the Windows installer. `inno` is the only one ZAX knows.     |
| `installer.windows.asset`      | no                 | The installer program. Absent takes the release's sole `.exe`.                         |
| `installer.other.run`          | one of the two     | The script inside the payload, run after it is extracted.                              |
| `installer.other.asset`        | no                 | The payload. Absent takes the release's sole archive.                                  |
| `creates.directory`            | one of the two     | The install this one makes beside the host, as one folder name.                        |
| `inputs`                       | with `creates`     | What ZAX asks the user for before installing, each with the file that checks it.       |
| `extract-dat.from`             | no                 | Which input's archive is unpacked into the created install.                            |
| `extract-dat.list`             | with `from`        | The response file naming what to lift out of it, one path per line.                    |
| `extract-dat.into`             | with `from`        | Where those files land inside the created install.                                     |
| `conflicts`                    | no                 | When installing refuses; see below.                                                    |
| `settings`                     | no                 | The settings schema; see [Settings](settings.md).                                      |

## What the release supplies

A committed manifest states neither its version nor its payload's name. The tag supplies the version, and the
release's sole archive-shaped asset supplies the payload. Two archives on one release is an ambiguity only the
author can settle, so `archive` names one; a release of loose files needs it too, since nothing there tells the
payload from the rest of what is published.

A base mod's installer assets go the same way: `installer.windows.asset` is the release's sole `.exe` and
`installer.other.asset` its sole archive unless the manifest names them. That is what lets a manifest whose
installer names carry the version stay a file written once - see [base mods](base-mods.md).

**A payload that is not an archive** is one file, deployed as it stands to the single `entries` name the
manifest declares - Cassidy's four `.dat` assets and the walk-speed fix's one are published that way. It has to
be named by `archive`, because inference stays archive-only.

Archives are checked before extraction: symlink entries, over 65,536 entries, paths deeper than 16 segments, or
over 8 GiB unpacked all refuse.

**A name Windows cannot create refuses too**, on every host rather than only there: a device name at any level
(`aux`, `nul`, `com1`, with or without an extension), any of `< > : " | ? *` or a control character, or a
segment ending in a dot or a space. Packing on Linux hides all three until a Windows user is half way through
an install, so the same payload is refused everywhere and `actions/pack-mod` says so on the run that made it.

**What the archiving machine wrote is dropped rather than installed**: `__MACOSX/`, `.DS_Store`, `Thumbs.db`,
`desktop.ini`. Nothing an author could have written is dropped on their behalf.

## What the mod needs of the install

```yaml
needs.game: [fallout2rpu]
needs.sfall: "4.4.5"
```

`needs.game` lists the game types the mod installs on, gating first installs; absent means any, and a base mod
that delegates to an installer defaults to vanilla alone. `needs.sfall` is the lowest version it works with, read as
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

## What the mod overrides

```yaml
order.overrides:
  - rpu.dat
order.overridden-by:
  - InventoryFilter.dat
```

`order.overrides` names entries your files win over; `order.overridden-by` names entries that win over yours.
That is all a place in `mods_order.txt` decides - which copy of a shared file the engine sees - so a claim
states the override rather than a position. Both lists name entries in `mods/`, spelled as the order file spells them,
rather than mod ids: the folder cannot say which mod put a dat there, so an id would place you against the mods
ZAX installed and against nothing else.

ZAX ships the orders the Restoration Project and the Unofficial Patch state for themselves, and those win where
they already name your entry: on one of those installs, that project's own file is the better statement.
Everything else is placed by what it claims, as late as the claim allows, and against entries other mods have
claimed their way to as well. A claim is satisfied by whichever of its names the install has, so it may name
something only some installs carry; one naming nothing here, or one whose two sides cross, leaves the mod
unranked, which leaves the order file holding it where it is.

Nothing here moves a line on its own. It decides where a first install puts one, and what the Mods tab's
recommendation and its sort button work from.

## Conflicts

```yaml
conflicts:
  - present: [mods/other.dat]
    absent: [mods/compat.ini]
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
UTF-8, at most 256 KB; text fields cap at 200 characters, 1000 for help, reasons and descriptions, and may not
hold control characters. `forum` and `homepage` must be `https` addresses with no whitespace in them: what
they name is handed to whatever the machine opens links with, so any other scheme would be a manifest choosing
what runs there rather than naming a page to read. Path-shaped fields are confined - absolute paths, drive
letters, `..`, or anything outside `mods/` refuse the manifest whole. A few named mods are granted one
directory beyond it, where the engine reads that directory from the filesystem and no archive can stand in for
it. The grant is ZAX's to give and not something a manifest can claim: declaring the path is how a mod says
where it writes, never how it gets permission.

## How the format changes

The `spec` number is a floor rather than a pin. ZAX reads any manifest written to the spec it implements or to
an earlier one, and refuses only one asking for more than it has. That is safe because the format is
append-only within a spec major: fields are added, a field's meaning never changes, and a retired field stays
parsed and ignored for a major before it goes. So adding an operator is a new field, changing one is a new field
plus a retirement, and only a removal needs a new major.

What ZAX does with something it does not recognise follows from what ignoring it would cost. A field that
decides what lands on disk - `entries`, `needs.game`, `type`, `conflicts` - refuses the manifest, because ignoring it
would write the wrong thing; that is why an unknown field refuses at all rather than being passed over. Inside
`settings` the cost is a control rather than a file, so an entry ZAX cannot draw is dropped and named instead.
