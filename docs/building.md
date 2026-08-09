# Building ZAX

## Requirements

Node 24 and pnpm. The pnpm version is pinned in the root `package.json`'s `packageManager` field, so
`corepack enable` is enough to get the right one.

```bash
pnpm install
```

Two packages are allowed to run install scripts - Electron and esbuild - because each fetches a prebuilt binary
it does not work without. Everything else is refused, and adding a dependency that wants one fails the install
rather than skipping it quietly.

## Running from a checkout

```bash
pnpm dev        # the interface alone, in a browser, against an in-memory disk
pnpm desktop    # build the shell and run it
```

The browser preview edits a bundled fixture rather than a real install: everything that only touches files works,
and everything that reaches the network or starts a program refuses and says why. Use `pnpm desktop` for anything
that has to touch a real game folder.

For interface work inside the real shell, run the dev server and point the shell at it, which keeps hot reload:

```bash
ZAX_DEV_SERVER=http://localhost:5173 pnpm --filter @zax/app start
```

## Checks

```bash
pnpm check   # tsc over the TypeScript packages, then svelte-check over the interface
pnpm lint    # eslint, then prettier --check
pnpm test    # the whole suite
```

CI runs all three on every push, installing with `--ignore-scripts`, and then builds the distributables on Linux,
Windows and macOS.

## Icons

`packages/ui/src/assets/zax.svg` is the source. The two PNGs beside it are generated and committed, so a build
needs nothing installed to produce them:

```bash
pnpm gen:icons   # writes packages/ui/public/zax.png (256) and packages/app/build/icon.png (1024)
```

It rasterises through a headless Chromium, which it looks for on `PATH`; set `CHROME` to a binary if yours is
elsewhere. Run it after editing the SVG and commit both PNGs with it - nothing in the build regenerates them,
so an SVG changed on its own leaves the shipped icon at the previous drawing.

## Distributables

```bash
pnpm --filter @zax/app package       # everything for the platform you are on
pnpm --filter @zax/app package:dir   # an unpacked directory, faster, for checking what shipped
```

Output lands in `packages/app/release/`. electron-builder downloads the Electron runtime for the target on first
use and caches it.

Each platform's artifacts are built on that platform - there is no cross-compilation here, which is why CI uses
three runners:

| Platform | Artifacts                                   |
| -------- | ------------------------------------------- |
| Windows  | `.zip`, and a single self-extracting `.exe` |
| Linux    | `.AppImage`, and a `.tar.gz`                |
| macOS    | `.zip` of the application bundle            |

There is no installer. ZAX has no file associations, no protocol handler, no service and nothing needing
administrator rights, so an installer would buy a start menu entry and cost a privileged step.

The Windows `.exe` unpacks itself into a temporary directory keyed to the version, so it extracts once and starts
immediately after that. The `.zip` is the one that genuinely runs in place. On Linux the AppImage is a single
file the kernel mounts rather than unpacks.

## Portable copies

Create a directory named `data` beside the executable, and ZAX keeps everything there instead of in the per-user
locations - the install list, backups, downloaded release archives and the log:

```
ZAX/
  zax            <- or ZAX.exe, or ZAX.app
  data/
    config/      <- zax.yml
    cache/       <- backups, downloads, the log
```

Creating the directory is the whole switch, so an installed copy cannot become portable because something wrote a
directory of that name. `ZAX_DATA_DIR` names one somewhere else, for anyone scripting it.

The two single-file formats hide the executable that is really running - the Windows build unpacks itself into a
temporary directory and an AppImage mounts itself read-only - so both are asked where they were launched from
rather than where they are executing. On macOS the data directory sits beside `ZAX.app`, not inside it, so moving
the application does not lose the settings.

## Platforms without an official Electron build

Electron ships binaries for Windows, macOS and Linux only. Elsewhere - FreeBSD being the one with a maintained
port - install the system Electron package and run the built application against it:

```bash
pnpm install
pnpm --filter @zax/app build
electron packages/app
```

`packages/app` holds a `package.json` whose `main` points at the built shell, which is all Electron needs to run
a directory. Match the system Electron's major version to the one in `packages/app/package.json` where you can; a
different major usually still runs, but nothing here is tested against one.

If no Electron is available at all, there is no way to run ZAX on that machine. The browser preview is not a
substitute - it edits an in-memory fixture and cannot reach the filesystem, which is the entire job.
