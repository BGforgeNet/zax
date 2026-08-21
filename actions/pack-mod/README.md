# `pack-mod`

Packs a mod's payload into an archive ZAX can install, on a version tag. The mod's repository commits an
`f2mod.yml` once; after that, the archive needs nothing per-release.

Attaching it to the release is your step - the action writes the archive into the workspace and names it in an
output.

```yaml
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: BGforgeNet/zax/actions/pack-mod@<zax-tag>
        id: pack
      - uses: softprops/action-gh-release@v3
        with:
          files: ${{ steps.pack.outputs.archive }}
```

Pin `<zax-tag>` to a ZAX release tag or a commit SHA; the ref has to exist on the ZAX repository. The checkout
is yours to do, so a mod that builds its files can run its build before packing them.

## What it does

Packs `mods/` into `<repository>_<tag>.zip` in the workspace - `fo2tweaks_v14.7.zip` for tag `v14.7`. It stamps nothing: ZAX reads the version
from the tag (`v14.7` is 14.7) and the payload from the release's sole archive asset, so the committed
manifest never changes between releases.

It refuses before packing anything when the run is not on a tag, when the tag names no version, when there is
no `f2mod.yml` at the repository root, or when nothing sits under `mods/` - each of which would otherwise
produce a release ZAX silently passes over.

| Input       | Default         |                                                                          |
| ----------- | --------------- | ------------------------------------------------------------------------ |
| `paths`     | `mods`          | What goes into the archive, one path per line, relative to `directory`.  |
| `directory` | `.`             | What those paths are relative to. `mods/` must land at the archive root. |
| `name`      | repository name | The archive's base name.                                                 |

| Output    |                                              |
| --------- | -------------------------------------------- |
| `archive` | The archive's name, written in the workspace |
| `version` | The version ZAX reads from the tag           |

## What ZAX needs from the release

- `f2mod.yml` at the repository root, committed - that is where ZAX reads it for the tag.
- `mods/` at the root of the archive. Everything under it is deployed; everything else is ignored.
- One archive asset on the release. Where a release carries several, name the payload in the manifest's
  `archive` field, or ZAX cannot tell which is the mod.

`docs/mod-format.md` in the ZAX repository is the manifest's specification, and `pnpm check-manifest <file>`
from a ZAX checkout validates one with the application's own parser.
