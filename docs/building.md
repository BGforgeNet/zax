# Building ZAX

## Requirements

Node 24 and pnpm. Its version is pinned in the root `package.json`'s `packageManager` field, so
`corepack enable` gets the right one.

```bash
pnpm install
```

Only Electron and esbuild may run install scripts, each fetching a prebuilt binary it does not work without.
A new dependency that wants one fails the install rather than being skipped quietly.

## Running from a checkout

```bash
pnpm dev        # the interface alone, in a browser, against an in-memory disk
pnpm desktop    # build the shell and run it
```

The browser preview edits a bundled fixture: everything that only touches files works, everything reaching
the network or starting a program refuses and says why. Use `pnpm desktop` for a real game folder.

For interface work inside the real shell, keep hot reload by pointing it at the dev server:

```bash
ZAX_DEV_SERVER=http://localhost:5173 pnpm --filter @zax/app start
```

## Checks

```bash
pnpm check           # tsc over the TypeScript packages, then svelte-check over the interface
pnpm lint            # eslint, then prettier --check
pnpm test            # the whole suite
pnpm test:coverage   # the same, measured against a floor
```

The coverage floor sits below what the suite reaches and only ever rises; it is there to make an untested
path visible, not to be aimed at. CI runs the measured variant, so the floor gates a change rather than
slowing every local run. The three process entry points are excluded - each constructs the window, the bridge
or the root component and holds no decision of its own, the decisions having been extracted into modules that
are covered.

CI runs all three on every push, installing with `--ignore-scripts`, then builds the distributables on Linux,
Windows and macOS.

The shell scripts, the workflows and the composite action are checked by `shellcheck`, `actionlint` and
`zizmor` in a job of their own - `.github/scripts/lint-workflows.sh`, which fetches the two the runner does
not carry. It is not part of `pnpm lint`: none of the three is a Node dependency, and requiring them on every
contributor's `PATH` costs more than the checks are worth locally. Run that script directly to reproduce a
failure.

## Icons

`packages/ui/src/assets/zax.svg` is the source; the two PNGs beside it are generated and committed, so a
build needs nothing installed to produce them.

```bash
pnpm gen:icons   # writes packages/ui/public/zax.png (256) and packages/app/build/icon.png (1024)
```

It rasterises through a headless Chromium found on `PATH`; `CHROME` names one elsewhere. Nothing in the build
regenerates the PNGs, so run this after editing the SVG and commit all three together.

## Distributables

```bash
pnpm --filter @zax/app package       # everything for the platform you are on
pnpm --filter @zax/app package:dir   # an unpacked directory, faster, for checking what shipped
```

Output lands in `packages/app/release/`. electron-builder downloads the Electron runtime for the target on
first use and caches it. There is no cross-compilation, which is why CI uses three runners:

| Platform | Artifacts                                   |
| -------- | ------------------------------------------- |
| Windows  | `.zip`, and a single self-extracting `.exe` |
| Linux    | `.AppImage`, and a `.tar.gz`                |
| macOS    | `.zip` of the application bundle            |

There is no installer: with no file associations, protocol handler, service or privileged step, one would buy
a start menu entry and cost administrator rights. Of the Windows pair, the `.zip` is the one that runs in
place - the `.exe` unpacks itself into a temporary directory keyed to the version. The AppImage is a single
file the kernel mounts rather than unpacks.

## Portable copies

A directory named `data` beside the executable holds everything ZAX would otherwise keep in per-user
locations - the install list, backups, downloaded archives and the log:

```
ZAX/
  zax            <- or ZAX.exe, or ZAX.app
  data/
    config/      <- zax.yml
    cache/       <- backups, downloads, the log
```

Creating the directory is the whole switch, so an installed copy cannot turn portable because something else
wrote a directory of that name. `ZAX_DATA_DIR` names one elsewhere, for anyone scripting it.

Both single-file formats hide the executable really running - the Windows build unpacks into a temporary
directory, an AppImage mounts itself read-only - so both are asked where they were launched from rather than
where they execute. On macOS the data directory sits beside `ZAX.app` rather than inside it, so moving the
application keeps the settings.

## Platforms without an official Electron build

Electron ships binaries for Windows, macOS and Linux only. Elsewhere - FreeBSD has the maintained port -
install the system Electron package and run the built application against it:

```bash
pnpm install
pnpm --filter @zax/app build
electron packages/app
```

`packages/app` holds a `package.json` whose `main` points at the built shell, which is all Electron needs to
run a directory. Match the system Electron's major to the one in `packages/app/package.json` where you can; a
different major usually runs, but nothing here is tested against one.

With no Electron at all there is no way to run ZAX on that machine. The browser preview is not a substitute:
it edits an in-memory fixture and cannot reach the filesystem, which is the entire job.
