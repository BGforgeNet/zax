# `publish-mod`

Publishes a ZAX-installable release from a version tag. The mod's repository commits an `f2mod.yml` once;
after that, `git push --tags` is the whole release procedure.

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
      - uses: BGforgeNet/zax/actions/publish-mod@<zax-tag>
```

Pin `<zax-tag>` to a ZAX release tag or a commit SHA; the ref has to exist on the ZAX repository. The checkout
is yours to do, so a mod that builds its files can run its build first and pack the result.

## What it does

Packs `mods/` into `<repository>-<version>.zip` and attaches it to the tag's release, creating that release if
the tag has none. It stamps nothing: ZAX reads the version from the tag (`v14.7` is 14.7) and the payload from
the release's sole archive asset, so the committed manifest never changes between releases.

It refuses before packing anything when the run is not on a tag, when the tag names no version, when there is
no `f2mod.yml` at the repository root, or when nothing sits under `mods/` - each of which would otherwise
publish a release ZAX silently passes over.

| Input       | Default         |                                                                          |
| ----------- | --------------- | ------------------------------------------------------------------------ |
| `paths`     | `mods`          | What goes into the archive, one path per line, relative to `directory`.  |
| `directory` | `.`             | What those paths are relative to. `mods/` must land at the archive root. |
| `name`      | repository name | The archive's base name.                                                 |
| `token`     | `github.token`  | The token the release is created with.                                   |

Outputs `archive` and `version`.

## What ZAX needs from the release

- `f2mod.yml` at the repository root, committed - that is where ZAX reads it for the tag.
- `mods/` at the root of the archive. Everything under it is deployed; everything else is ignored.
- One archive asset per release. Where a release carries several, name the payload in the manifest's
  `archive` field - the action warns when it sees more than one.

`docs/mod-format.md` in the ZAX repository is the manifest's specification, and `pnpm check-manifest <file>`
from a ZAX checkout validates one with the application's own parser.
