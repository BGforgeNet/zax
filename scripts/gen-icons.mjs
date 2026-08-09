/**
 * Rasterises the icon source into the two PNGs the application ships: the interface's favicon, which the
 * desktop shell also hands the window, and the 1024px one electron-builder turns into a `.ico` and a `.icns`.
 *
 * Through a browser rather than a converter because the SVG uses a filter and a pattern, and the small
 * converters render neither - this is also the renderer the interface itself draws the mark with, so what
 * ships and what is on screen cannot diverge. Point `CHROME` at a binary, or leave it and one is looked for
 * on `PATH`.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages/ui/src/assets/zax.svg");

const OUTPUTS = [
  { path: "packages/ui/public/zax.png", size: 256 },
  { path: "packages/app/build/icon.png", size: 1024 },
];

const CANDIDATES = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable"];

/** The first browser that answers `--version`, or an explanation of what to install rather than a spawn error. */
function browser() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const name of CANDIDATES) {
    try {
      execFileSync(name, ["--version"], { stdio: "ignore" });
      return name;
    } catch {
      // Not this one; the loop reports only when every candidate has been tried.
    }
  }
  throw new Error(`No browser found. Install Chromium or set CHROME to one. Tried: ${CANDIDATES.join(", ")}`);
}

function render(chrome, size, destination) {
  const work = mkdtempSync(join(tmpdir(), "zax-icon-"));
  try {
    copyFileSync(source, join(work, "icon.svg"));
    // The image is sized in CSS pixels and the window matches it, so the shot is the icon and nothing else.
    writeFileSync(
      join(work, "page.html"),
      `<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style>` +
        `<img src="icon.svg">`,
    );
    execFileSync(
      chrome,
      [
        "--headless",
        "--disable-gpu",
        "--no-sandbox",
        "--hide-scrollbars",
        // Without this the transparent corners come out white, which shows as a box on any dark taskbar.
        "--default-background-color=00000000",
        "--force-device-scale-factor=1",
        `--window-size=${size},${size}`,
        `--screenshot=${join(work, "out.png")}`,
        join(work, "page.html"),
      ],
      { stdio: "ignore" },
    );
    copyFileSync(join(work, "out.png"), join(root, destination));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const chrome = browser();
for (const { path, size } of OUTPUTS) {
  render(chrome, size, path);
  console.log(`${path} (${size}px)`);
}
