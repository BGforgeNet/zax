# Building ZAX

## Requirements

- **Node 24 and pnpm.** pnpm's version is pinned in the root `package.json`'s `packageManager` field, so
  `corepack enable` gets the right one.
- **Rust through rustup.** `rust-toolchain.toml` names the compiler and the `wasm32-unknown-unknown` target, and
  rustup installs both on first use. The version is pinned rather than following stable because the mod-ini
  action's WebAssembly is committed and compared against a rebuild, and another compiler builds other bytes.
- **wasm-bindgen-cli** at the version `Cargo.lock` pins, which `.github/scripts/install-wasm-bindgen.sh`
  installs. The browser preview and the interface's tests run on the domain compiled to WebAssembly.
- **On Linux, the webview's development files**: `.github/scripts/install-linux-deps.sh` names the packages
  for Debian and Ubuntu. Windows needs the WebView2 runtime, which Windows 11 ships with; macOS needs nothing.

`@types/node` tracks the Node major rather than the newest published one, so it stays on the 24 line for as
long as this is built and tested against Node 24. An update tool reporting it as two majors behind is
describing the runtime, not the pin.

TypeScript stays on the 6.0 line for the same kind of reason. The 7.0 compiler is stable, but it ships without
a stable programmatic API until 7.1, and both `typescript-eslint` and `svelte-check` are built on that API and
cap their peer range at 6 - so `pnpm lint` and `pnpm check` are what the bump is waiting on rather than the
compiler itself. On 7.0 `pnpm check` fails first in `imports.test.ts`, which calls `ts.preProcessFile`, one of
the entry points that surface does not yet carry.

```bash
pnpm install
scripts/build-preview.sh
```

Only esbuild may run an install script. A new dependency that wants one fails the install rather than being
skipped quietly.

## Running from a checkout

```bash
pnpm dev        # the interface alone, in a browser, against an in-memory disk
pnpm desktop    # the Tauri shell, over the same dev server, with hot reload
```

The browser preview edits a bundled fixture: everything that only touches files works, everything reaching
the network or starting a program refuses and says why. Use `pnpm desktop` for a real game folder.

## Checks

```bash
pnpm check                      # tsc over the scripts, then svelte-check over the interface
pnpm lint                       # oxlint, then eslint over the components, then oxfmt --check
pnpm test                       # the interface's suite, against the WebAssembly preview
pnpm test:coverage              # the same, measured against a floor
.github/scripts/rust-gate.sh    # the Rust workspace: format, clippy on both targets, tests, bindings
pnpm drive                      # the release build driven through its own window, over WebDriver
```

`pnpm drive` needs a release build in `target/release` (`pnpm exec tauri build --no-bundle`), or `ZAX_PROGRAM`
naming a program elsewhere, `tauri-driver` on `PATH` (`cargo install tauri-driver --locked`), and the platform's
native driver: `WebKitWebDriver` on Linux, with a display, or on Windows the Edge driver matching the installed
WebView2. macOS has no driver for its webview.
`.github/scripts/install-drive-tools.sh` is what CI installs them with.

The scripts are checked as JavaScript through `tsconfig.scripts.json`, which turns off `noImplicitAny` and
leaves the rest of the strict set on: the errors worth having there are wrong arguments and unguarded
absences, and annotating every parameter of a generator that reads YAML would buy little for the work.

The interface's TypeScript types for what crosses to the shell are generated from the Rust by ts-rs, into
`packages/ui/src/lib/bindings/`, whenever the Rust tests run. The Rust gate fails when they differ from what is
committed.

The coverage floor sits below what the suite reaches and only ever rises; it is there to make an untested
path visible, not to be aimed at. CI runs the measured variant, so the floor gates a change rather than
slowing every local run. Components are measured alongside the TypeScript: the interface is where the wording
a user reads is decided, and leaving `.svelte` out of the ratio would have said nothing about it.

CI runs the interface's checks and the Rust gate on every push, then builds the distributables on Linux,
Windows and macOS. The domain's tests run a second time on Windows, on their own: `zax-host` is where the real
filesystem, process launch and registry calls are, and drive letters, a case-insensitive filesystem and
`reg query` have no equivalent on the Linux runner.

Each build is then run: `pnpm drive` on Linux and Windows, and on macOS, where it cannot,
`.github/scripts/launch-macos.sh` - which unpacks the bundle, checks it carries a build for the machine, starts
it and requires it to stay up without panicking. What that misses is a window that opens empty, and Gatekeeper,
which lets a bundle built on the runner through because nothing marked it as downloaded.

The shell scripts, the workflows and the composite action are checked by `shellcheck`, `actionlint` and
`zizmor` in a job of their own - `.github/scripts/lint-workflows.sh`, which fetches the two the runner does
not carry. It is not part of `pnpm lint`: none of the three is a Node dependency, and requiring them on every
contributor's `PATH` costs more than the checks are worth locally. Run that script directly to reproduce a
failure.

## Icons

`packages/ui/src/assets/zax.svg` is the source; the favicon and the bundle's icons are generated and committed,
so a build needs nothing installed to produce them.

```bash
pnpm gen:icons   # packages/ui/public/zax.png, and the icons tauri.conf.json names under crates/shell/icons
```

It rasterises through a headless Chromium found on `PATH`; `CHROME` names one elsewhere. Nothing in the build
regenerates them, so run this after editing the SVG and commit them together.

## Distributables

```bash
.github/scripts/package.sh   # everything for the platform you are on, into release/
```

There is no cross-compilation, which is why CI uses three runners:

| Platform | Artifacts                                   |
| -------- | ------------------------------------------- |
| Windows  | `.exe`, and the same program in a `.zip`    |
| Linux    | `.AppImage`, and a `.tar.gz` of the program |
| macOS    | `.zip` of the application bundle            |

There is no installer: with no file associations, protocol handler, service or privileged step, one would buy
a start menu entry and cost administrator rights. The Windows program is one file with the interface inside it
and runs where it lies. The AppImage carries its own webview libraries and is mounted rather than unpacked; the
tarball's program uses the system's WebKitGTK 4.1.

Neither Linux artifact carries a glibc, so the one the runner builds against is the oldest release the program
starts on - an older one refuses at the loader, before `main`. CI packages Linux on the oldest image GitHub
offers for that reason, which puts the floor at Ubuntu 22.04 and Debian 12. Reading it off a build:
`readelf -V <program> | grep GLIBC_` names the versions it needs, and the highest is the floor.

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

A directory named `data` beside the program holds everything ZAX would otherwise keep in per-user locations -
the install list, backups, downloaded archives and the log:

```
ZAX/
  zax            <- or zax.exe, or ZAX.app
  data/
    config/      <- zax.yml
    cache/       <- backups, downloads, the log
```

Creating the directory is the whole switch, so an installed copy cannot turn portable because something else
wrote a directory of that name. `ZAX_DATA_DIR` names one elsewhere, for anyone scripting it.

An AppImage mounts itself read-only somewhere under `/tmp`, so it is asked where the image itself is rather than
where its program runs. On macOS the data directory sits beside `ZAX.app` rather than inside it, so moving the
application keeps the settings.

## Other platforms

The shell is Tauri, which draws in the system's webview: WebKitGTK on Linux and the BSDs, WKWebView on macOS,
WebView2 on Windows. Nothing here builds or tests a BSD package; where WebKitGTK 4.1 and a Rust toolchain are
available, `pnpm install` followed by `pnpm exec tauri build --no-bundle` is the route to try, and nothing
promises it works.

The browser preview is not a substitute: it edits an in-memory fixture and cannot reach the filesystem, which is
the entire job.
