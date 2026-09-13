# `mod-ini`

Checks a mod's ini files against the settings its `f2mod.yml` describes, or writes them from it and pushes the
result. It applies the same rules as `pnpm mod-ini` from a ZAX checkout; [Settings](../../docs/mod-format/settings.md)
describes the schema.

```yaml
name: ini

on:
  push:
    branches: ["**"]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v6
        with:
          persist-credentials: false
      - uses: BGforgeNet/zax/actions/mod-ini@<zax-tag>
        with:
          match: hard
```

Pin `<zax-tag>` to a ZAX release tag or a commit SHA; the ref has to exist on the ZAX repository.

## Check

Fails, naming each mismatch, when a described key is missing from its file, when the file ships a value other
than the setting's `default`, or when the value is one the setting's `kind` refuses - a bool that is neither its
on nor its off value, a number out of range, a choice not among its options. A manifest this version of ZAX
cannot read whole fails too, since part of the schema would go unchecked.

`match` decides what the file may carry beyond that. `soft` lets it hold entries and sections the schema leaves
out, which the format allows. `hard` fails on every one of them, empty sections included.

## Generate

Writes each file the settings name from the manifest alone - each section under its `settings.sections.<name>`
description, and per setting its help (or its label, where it has none) and accepted values as comments above
`key=default` - replacing whatever the file held. Keys the schema does not describe are gone afterwards, so
generate suits a mod whose schema describes its whole ini. Every setting needs a `default`.

It then commits the files it wrote, and nothing else the job staged, and pushes to the branch the run is on.
The job needs `contents: write`, and a checkout that keeps its credentials:

```yaml
on:
  push:
    branches: [main]

permissions:
  contents: write

jobs:
  generate:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v6
      - uses: BGforgeNet/zax/actions/mod-ini@<zax-tag>
        with:
          mode: generate
```

It refuses on a pull request or a tag, where there is no branch for the push to land on. A push made with the
job's own token starts no further workflow run, so the commit does not trigger generate again.

| Input       | Default |                                                                                      |
| ----------- | ------- | ------------------------------------------------------------------------------------ |
| `mode`      | `check` | `check`, or `generate` to write, commit and push the files.                          |
| `match`     | `soft`  | For check: `soft` allows entries the schema leaves out, `hard` wants an exact match. |
| `directory` | `.`     | What the settings' `mods/...` paths are relative to, as in `pack-mod`.               |

| Output    |                                                                  |
| --------- | ---------------------------------------------------------------- |
| `changed` | Whether generate committed and pushed. Always `false` for check. |

`pack-mod` runs the same check before packing a release when its `check-ini` input is set.
