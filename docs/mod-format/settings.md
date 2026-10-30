# Settings

A mod's own options, described so ZAX draws them as controls instead of leaving the user to edit an ini by hand.
A mod without a schema simply has no settings surface, and a partial one is fine.

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

A flat mapping keyed by the entry's real address in the ini, `section.key`, split at the first dot - a section
name cannot contain a dot, a key can. An entry may name its `file` (under `mods/`, default `mods/<id>.ini`) and
carries a `kind` with that kind's fields:

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
control gated on nothing would render live and never take effect. A `kind` this version does not implement goes
the same way. The mod still installs, and ZAX says how many controls it left out and which: a settings entry
only ever edits a key in the mod's own ini, where the release ships its own default, so one ZAX cannot draw
costs a knob rather than correctness. Which settings a version knows changes with every ZAX release, and a mod
must not become uninstallable for having sat on the wrong side of one.

A gated control carries a link that sets what it waits on, following the chain where the controller is gated in
turn, so list `is` values in the order you would recommend them - the first is the one that link writes.

A section can say what it is for, one top-level key per section, spelled as the addresses spell it:

```yaml
settings.sections.main: Turn each component on or off.
settings.sections.run_speed: Fine tuning for the run speed component.
```

A description naming a section no setting is in refuses the manifest, since that is a misspelt section. Its text
runs to 1000 characters, and a block scalar keeps its line breaks.

The ini files a mod ships are the user's to edit, and an upgrade keeps their edits: every `.ini` in the payload
is merged key by key, the user's values winning over the release's new defaults, with the previously shipped
copy telling the two apart.

## Keeping the schema and the ini together

Nothing at install compares the two, so a key renamed in the ini and not here becomes a control that writes a
line the mod never reads. `pnpm mod-ini check` from a ZAX checkout catches that before a release: every described
key must be in its file, with its `default` as the value shipped and a value its `kind` accepts. `--match soft`,
the default, lets the file carry entries the schema leaves out; `--match hard` wants the two to agree exactly.
`pnpm mod-ini generate` goes the other way and writes each file from the schema alone, replacing what it held:
each section's description as comments above its header, and each setting's help and accepted values as comments
above its key, with its label standing in for a setting that has no help.
The [`mod-ini` action](../../actions/mod-ini/README.md) runs either in a repository's CI.
