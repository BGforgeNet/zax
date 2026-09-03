# Releases

## How ZAX chooses one

A feed entry names a repository and the id it follows. Of the releases whose manifest carries that id, ZAX takes
the highest manifest `version` - not the newest by date, so a hotfix on an older line does not shadow the
current one. It reads the hundred most recent releases, which is as many as one request may ask for; past that,
a hotfix to a line that old is not seen. Two ids may share a repository, each on its own tags. A manifest that
refuses to parse is reported rather than skipped: when no release matches, the first refusal is the answer.

The manifest is read from the repository at the release's tag, and nothing else on the release describes it. A
tag's tree does not change once pushed, so what is read for one is kept; a tag that carries no manifest is
remembered as carrying none, which is what keeps following a repository from costing one request per release
every time the listing refreshes.

## Installing, upgrading, removing

- **Recorded per install**: version, deployed files, the manifest, and the ini files as shipped.
- **Upgrade replaces, never overlays.** Files the new release drops are backed up and removed, top-level `.dat`s
  are enabled in the load order, and each ini merges with the user's changes winning over new defaults - the
  previously shipped copy tells the two apart.
- **Removal** deletes exactly the recorded files, copies first going to a timestamped backup.
- **Installed by hand** (present, no record): offered the current release laid over it, removed by the
  `mods/<id>.*` convention.
- **No longer followed** by the feed list: stays listed, with a note that updates will not be offered. Removal
  still works from the record.

## Getting a feed to follow a mod

The feed list ships in ZAX's code and changes only with a ZAX release - installing a mod is trusting its
publisher, and the list is where that trust is granted. Add the repository and id to `MOD_FEEDS` in
`packages/games-fallout2/src/mod-feed.ts`. A mod that has to write outside `mods/` needs a second entry, in
`MOD_GRANTS` in `packages/games-fallout2/src/mod-grants.ts`, naming the directory and why nothing packable would
do.
