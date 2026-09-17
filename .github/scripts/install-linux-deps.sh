#!/bin/bash
# The system packages a Linux runner needs to build the shell: the webview it binds against and what the
# AppImage bundler copies into the image. Tauri's own prerequisites for Linux, less what nothing here uses.
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev \
  libsoup-3.0-dev \
  libssl-dev \
  librsvg2-dev \
  file
