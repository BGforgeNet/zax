# Building ZAX

## Requirements

Node 24 and pnpm. Its version is pinned in the root `package.json`'s `packageManager` field, so
`corepack enable` gets the right one.

`@types/node` tracks the Node major rather than the newest published one, so it stays on the 24 line for as
long as this is built and tested against Node 24. An update tool reporting it as two majors behind is
describing the runtime, not the pin.

TypeScript stays on the 6.0 line for the same kind of reason. The 7.0 compiler is stable, but it ships without
a stable programmatic API until 7.1, and both `typescript-eslint` and `svelte-check` are built on that API and
cap their peer range at 6 - so `pnpm lint` and `pnpm check` are what the bump is waiting on rather than the
compiler itself. On 7.0 `pnpm check` fails first in `seam.test.ts`, which calls `ts.preProcessFile`, one of the
entry points that surface does not yet carry.

Electron stays a major behind the newest for a while after one ships. A `.0.0` has no patch release behind it
yet, and what a bad Electron does here is break packaging - which surfaces in the `build` job on three runners
rather than in anything `pnpm test` runs, so the cost of finding out late is a release that cannot be built. A
new major waits for a patch on its line, or for its first minor; `renovate.json5` parks electron and
electron-builder behind dashboard approval so the wait is a decision somebody makes rather than a bump that
lands on a schedule.

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
pnpm check           # tsc over the TypeScript packages and over the build and generator scripts, then
                     # svelte-check over the interface
pnpm lint            # oxlint, then eslint over the components, then oxfmt --check
pnpm test            # the whole suite
pnpm test:coverage   # the same, measured against a floor
```

The scripts are checked as JavaScript through `tsconfig.scripts.json`, which turns off `noImplicitAny` and
leaves the rest of the strict set on: the errors worth having there are wrong arguments and unguarded
absences, and annotating every parameter of a generator that reads YAML would buy little for the work.

The coverage floor sits below what the suite reaches and only ever rises; it is there to make an untested
path visible, not to be aimed at. CI runs the measured variant, so the floor gates a change rather than
slowing every local run. Components are measured alongside the TypeScript: the interface is where the wording
a user reads is decided, and leaving `.svelte` out of the ratio would have said nothing about it. The three
process entry points are excluded - each constructs the window, the bridge or the root component and holds no
decision of its own, the decisions having been extracted into modules that are covered - as are the two
generated data tables, which are one long literal each, and the component tests' own harness.

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

## First run on Windows and macOS

Nothing ZAX ships is code-signed, so both systems warn once. Neither warning means the download is damaged.

- **Windows.** SmartScreen shows "Windows protected your PC". More info, then Run anyway.
- **macOS.** Open the app, dismiss the refusal, then System Settings -> Privacy & Security -> Open Anyway ->
  Open. First launch only. Sequoia removed the Control-click shortcut that used to do this, so the app's own
  context menu no longer offers it.

What a release does carry is build provenance. `gh attestation verify <file> --repo BGforgeNet/zax` says which
workflow at which commit produced the file, which is the check that distinguishes a genuine build from a
reupload - signing would not add that.

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
