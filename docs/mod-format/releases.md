# Releases

## How ZAX chooses one

ZAX reads one document, the mod index, which is rebuilt once a day from the repositories it follows. For each
release the indexer reads the manifest from the repository at the release's tag, and writes it into the index
with every value explicit: the version (the tag's, where the manifest states none), and every asset it uses,
with the SHA-256 GitHub states for it. Two ids may share a repository, each on its own tags.

A release is left out of the index where GitHub states no digest for its assets (anything uploaded before GitHub
began recording them), where it is a draft or a prerelease, or where its manifest is refused. The indexer's log
names each refused release with the reason, and counts the ones left out for having no digest.

The indexer ranks a mod's releases - by version, not by date, so a hotfix on an older line does not shadow the
current one - and ZAX offers the highest-ranked release it can install.

## A published release is finished

Do not edit a release once it is published: not the tag, not the assets, not a re-upload under the same name.
The index takes the digest GitHub states, so a payload swapped underneath a published version is two different
sets of bytes under one version number, and which one a given machine installed depends on when it looked.

Nothing enforces this, which is why it is worth saying. A correction is a new tag: the version is what the tag
says, so `v14.7.1` costs nothing beyond pushing it, and it reaches every install as an upgrade rather than as
a difference nobody can see.

## Installing, upgrading, removing

- **Recorded per install**: version, deployed files, the manifest, and the ini files as shipped.
- **Upgrade replaces, never overlays.** Files the new release drops are backed up and removed, its load order
  entries are enabled only where they are new (one the previous release shipped stays on or off as the user left
  it), and each ini merges with the user's changes winning over new defaults - the previously shipped copy tells
  the two apart.
- **Removal** deletes exactly the recorded files, copies first going to a timestamped backup, and then the folders
  under `mods/` that this leaves empty.
- **While Fission's list holds the load order** (Fission ran last), installing and removing are refused: sfall's
  list waits beside it until the game or another engine is run, and lines written now would never reach it.
- **Installed by hand** (present, no record): offered the current release laid over it, removed by the
  `mods/<id>.*` convention.
- **Installed at a version the index does not list**: offered the current release in its place, without calling
  it an upgrade, since nothing can say which of the two is newer.
- **No longer followed** (the index does not list the id): stays listed, with a note that updates will not be
  offered. Removal still works from the record, as it does while the index cannot be read at all.

## Getting a mod into the index

A mod is followed once ZAX's maintainers add a source file for it to the mod index - installing a mod is
trusting its publisher, and that file is where the trust is granted. The source files are on
[the index branch](https://github.com/BGforgeNet/zax/tree/index/sources), and their format is described in
[the indexer](../../crates/indexer/src/source.rs). A mod that has to write outside `mods/` is granted the
directory there, under `grants`, with why nothing packable would do.
