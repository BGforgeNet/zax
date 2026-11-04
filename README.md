# ZAX

[![CI status](https://github.com/BGforgeNet/zax/actions/workflows/ci.yml/badge.svg)](https://github.com/BGforgeNet/zax/actions/workflows/ci.yml)
[![Patreon](https://img.shields.io/badge/Patreon-support-FF424D?logo=Patreon&labelColor=141518)](https://www.patreon.com/BGforge)
[![Telegram](https://img.shields.io/badge/telegram-join%20%20%20%20%E2%9D%B1%E2%9D%B1%E2%9D%B1-darkorange?logo=telegram)](https://t.me/bgforge)
[![Discord](https://img.shields.io/discord/420268540700917760?logo=discord&label=discord&color=blue&logoColor=FEE75C)](https://discord.gg/4Yqfggm)
[![IRC](https://img.shields.io/badge/%23IRC-join%20%20%20%20%E2%9D%B1%E2%9D%B1%E2%9D%B1-darkorange)](https://bgforge.net/irc)

ZAX is a configuration and mod manager for Fallout 2 engine games. It unifies game and mod settings in one
interface, installs and updates mods, updates sfall, installs and updates an alternative game engine, and
packages debug info for bug reports. It should work with any game based on the Fallout 2 engine.

### Installation

Download the file for your system from the [releases page](https://github.com/BGforgeNet/zax/releases). There is
nothing to install: each runs where you put it.

- Windows: the `.exe`, or the same program in a `.zip`.
- Linux: the `.AppImage`. The `.tar.gz` holds the bare program, which uses the system's own WebKitGTK 4.1.
- macOS: the `.zip` holds `ZAX.app`.

None of them is code-signed, so Windows and macOS warn on the first run:
[how to get past it](docs/building.md#first-run-on-windows-and-macos). A `data` directory beside the program makes
the copy [portable](docs/building.md#portable-copies).

The same page carries the earlier Python versions, up to 0.7. To run ZAX from a checkout, see
[Building](docs/building.md).

### Info

- [Forums](https://forums.bgforge.net/viewforum.php?f=34)
- [Building](docs/building.md)
- [Changelog](docs/changelog.md)
