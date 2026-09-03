# The mod manifest: `f2mod.yml`

One file at your repository's root tells ZAX how to install your mod. Four lines are a manifest:

```yaml
spec: 1
id: fo2tweaks
name: FO2tweaks
game: fallout2
```

Commit it, then release by pushing a version tag. The tag names the version - `v14.7` is 14.7, and a tag shaped
like anything else is passed over - and the release's sole archive asset is the payload. There is nothing to
maintain per release, and the `actions/pack-mod` action in this repository packs the archive for you.

Everything under `mods/` in that archive is installed and everything else is ignored. ZAX writes a line into
`mods/mods_order.txt` for each top-level `.dat`, which is what makes sfall load the mod. A payload's SHA-256
(GitHub publishes one per asset) is required, and a download that does not match is discarded.

`pnpm check-manifest <file>` from a ZAX checkout applies exactly the rules ZAX will, and
`packages/games-fallout2/src/manifest.ts` is the implementation those rules live in.

## The rest of the format

Each page is the whole of its subject; nothing below is needed for a mod that is one archive of dats.

- [Fields](mod-format/fields.md) - every field, what a release supplies for you, what parsing refuses, and how
  the format changes between spec versions.
- [Parts](mod-format/parts.md) - a release that publishes several payloads and asks which of them to install.
- [Base mods](mod-format/base-mods.md) - a mod that turns the game into a different edition, or builds a second
  game beside it.
- [Settings](mod-format/settings.md) - describing your mod's own options so ZAX draws them as controls.
- [Releases](mod-format/releases.md) - which release ZAX offers, what installing, upgrading and removing do,
  and how a repository gets followed at all.

## The id is forever

The `id` is the feed match, the settings-id prefix, the removal convention and the record key. Renaming it
publishes a different mod: existing installs would be offered a fresh install beside themselves rather than an
upgrade. Ids may not begin with `game`, `hires` or `sfall`, the catalog's own namespaces. Part ids are forever
for the same reason, as [Parts](mod-format/parts.md) spells out.

## Publishing nothing, for now

ZAX carries manifests for the mods that describe themselves nowhere - the base mods, so far - so that they can
be installed at all. Such a manifest is written by ZAX, ships in ZAX, and changes only with a ZAX release, which
makes it a worse description of your mod than yours would be: it cannot know about a release until someone
updates it. Publishing your own overrides it from the next release onward, with no coordination needed. The
entry naming your mod is in `packages/games-fallout2/src/mod-vendored.ts`, and it is deleted once you publish.
