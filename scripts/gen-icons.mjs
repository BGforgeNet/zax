/**
 * Rasterises the icon source into what the application ships: the interface's favicon, and the bundle's icons,
 * which `tauri icon` cuts from a 1024px rendering into the sizes and the `.ico` and `.icns` each platform wants.
 *
 * Through a browser rather than a converter because it is the renderer the interface itself draws the mark
 * with, so what ships and what is on screen cannot diverge. Point `CHROME` at a binary, or leave it and one
 * is looked for on `PATH`.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages/ui/src/assets/zax.svg");

const FAVICON = { path: "packages/ui/public/zax.png", size: 256 };
const BUNDLE_SOURCE_SIZE = 1024;
const SHELL = "crates/shell";

/**
 * The icons the bundle names, read from its config. `tauri icon` also writes store and mobile sizes, which
 * nothing here builds for, so only these are kept.
 */
const BUNDLE_FILES = JSON.parse(readFileSync(join(root, SHELL, "tauri.conf.json"), "utf8")).bundle.icon;

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
    // Resolved rather than joined, so a destination may be absolute as well as relative to the repository.
    copyFileSync(join(work, "out.png"), resolve(root, destination));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const chrome = browser();
render(chrome, FAVICON.size, FAVICON.path);
console.log(`${FAVICON.path} (${FAVICON.size}px)`);

const work = mkdtempSync(join(tmpdir(), "zax-bundle-icons-"));
try {
  const large = join(work, "icon.png");
  render(chrome, BUNDLE_SOURCE_SIZE, large);
  // Through pnpm, which puts the pinned CLI on PATH, rather than a bare `tauri` that may be any version or none.
  // Piped rather than shown: it reports every size it writes, and a failure's thrown message carries its stderr.
  execFileSync("pnpm", ["exec", "tauri", "icon", large, "--output", join(work, "icons")], {
    cwd: root,
    stdio: "pipe",
  });
  mkdirSync(join(root, SHELL, "icons"), { recursive: true });
  // Each is named relative to the config, as `icons/<file>`, which is also where `tauri icon` put it under `work`.
  for (const file of BUNDLE_FILES) copyFileSync(join(work, file), join(root, SHELL, file));
  console.log(`${SHELL}: ${BUNDLE_FILES.join(", ")}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
