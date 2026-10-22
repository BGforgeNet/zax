#!/bin/bash
# The system packages a Linux runner needs to build the shell: the webview it binds against and what the
# AppImage bundler copies into the image. Tauri's own prerequisites for Linux, less what nothing here uses.
# The second group is the GPUI spike's (zax-gpui): the fonts, Wayland and keyboard libraries it links.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  libssl-dev \
  librsvg2-dev \
  file \
  pkg-config \
  libfontconfig-dev \
  libfreetype-dev \
  libwayland-dev \
  libxkbcommon-dev \
  libxkbcommon-x11-dev \
  libx11-xcb-dev \
  libxcb1-dev
