# ZAX

[![CI status](https://github.com/BGforgeNet/zax/actions/workflows/ci.yml/badge.svg)](https://github.com/BGforgeNet/zax/actions/workflows/ci.yml)
[![Patreon](https://img.shields.io/badge/Patreon-donate-FF424D?logo=Patreon&labelColor=141518)](https://www.patreon.com/BGforge)

[![Telegram](https://img.shields.io/badge/telegram-join%20%20%20%20%E2%9D%B1%E2%9D%B1%E2%9D%B1-darkorange?logo=telegram)](https://t.me/bgforge)
[![Discord](https://img.shields.io/discord/420268540700917760?logo=discord&label=discord&color=blue&logoColor=FEE75C)](https://discord.gg/4Yqfggm)
[![IRC](https://img.shields.io/badge/%23IRC-join%20%20%20%20%E2%9D%B1%E2%9D%B1%E2%9D%B1-darkorange)](https://bgforge.net/irc)

ZAX is a configuration and mod manager for Fallout 2 engine games. It unifies game and mod settings in one
interface, installs and updates mods, updates sfall, installs and updates an alternative game engine, and
packages debug info for bug reports. It should work with any game based on the Fallout 2 engine.

### Installation

No packaged release yet - run it from a checkout, see [Building](docs/building.md):

```bash
pnpm install
pnpm desktop
```

`.github/scripts/package.sh` produces distributables for the platform you are on.

The [releases page](https://github.com/BGforgeNet/zax/releases) carries the earlier Python versions, up to 0.7.

### Blank window or crash on Linux

ZAX draws in WebKitGTK, whose accelerated rendering fails on some drivers, most often NVIDIA's proprietary one
under Wayland: the window stays white, or the program quits with `Error 71 (Protocol error)`. Start it with one
of these set, in this order: the first costs nothing, and each after it gives up more of the fast drawing path.
`ZAX.AppImage` stands for the file you downloaded.

```bash
__NV_DISABLE_EXPLICIT_SYNC=1 ./ZAX.AppImage        # NVIDIA only
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./ZAX.AppImage
WEBKIT_DISABLE_COMPOSITING_MODE=1 ./ZAX.AppImage   # no accelerated compositing at all
```

The same works for the program from the tarball. Tauri's
[Linux graphics notes](https://v2.tauri.app/develop/debug/linux-graphics/) cover the symptoms in more detail.

### Info

- [Forums](https://forums.bgforge.net/viewforum.php?f=34)
- [Building](docs/building.md)
- [Changelog](docs/changelog.md)
