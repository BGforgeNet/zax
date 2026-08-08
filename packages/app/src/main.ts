/**
 * The desktop shell. It owns the platform and the window, and answers one channel: the operations the interface
 * is allowed to ask for, dispatched by name.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { logFile } from "@zax/core";
import { BACKEND_METHODS, createBackend, type Backend } from "@zax/fallout2";
import { nodePlatform } from "@zax/platform-node";
import { CHANNEL } from "./channel.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the interface is served from: the built files beside this one, or the dev server when one is given. */
const DEV_SERVER = process.env["ZAX_DEV_SERVER"];

const platform = nodePlatform();
const LOG = logFile(platform);

/** One line per event, in the file the interface's "open log" button points at. */
async function logLine(text: string): Promise<void> {
  try {
    await mkdir(dirname(LOG), { recursive: true });
    await appendFile(LOG, `${new Date().toISOString()} ${text}\n`);
  } catch {
    // Logging must never take the process down with it; there is nowhere left to report its own failure.
  }
}

const describeError = (error: unknown): string =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

// A crash with no window leaves nothing to read; these lines are the only trace a bug report can carry.
process.on("uncaughtException", (error) => void logLine(`uncaught: ${describeError(error)}`));
process.on("unhandledRejection", (reason) => void logLine(`unhandled rejection: ${describeError(reason)}`));

function register(backend: Backend): void {
  const callable = backend as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  ipcMain.handle(CHANNEL, async (_event, method: string, args: unknown[]) => {
    // Only the named operations, and only by exact name: a renderer asking for anything else gets an error
    // rather than a lookup on the object's prototype.
    if (!(BACKEND_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown operation: ${method}`);
    try {
      return await callable[method]!(...args);
    } catch (error) {
      // The renderer's notice shows the message; the log keeps the stack, which the notice cannot carry.
      void logLine(`${method} failed: ${describeError(error)}`);
      throw error;
    }
  });
}

/**
 * The directory picker, attached to the window so it is modal to it rather than a stray dialog. Returns null on
 * cancel, which is not a failure: the caller simply has nothing to add.
 */
async function chooseFolder(): Promise<string | null> {
  const [parent] = BrowserWindow.getAllWindows();
  const options = { title: "Select the game folder", properties: ["openDirectory" as const] };
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

/**
 * Handing an arbitrary scheme to the desktop's own handler is how a `file://` path or a registered protocol
 * becomes code execution, so only the two schemes a link can legitimately carry are passed on.
 */
function isWebUrl(target: string): boolean {
  try {
    const { protocol } = new URL(target);
    return protocol === "https:" || protocol === "http:";
  } catch {
    // Not a URL at all, which is not something to hand outwards either.
    return false;
  }
}

/** Where this window is allowed to go: the dev server when one is given, otherwise the built files. */
function isOwnContent(target: string): boolean {
  try {
    const url = new URL(target);
    // Same truthiness test the load below makes, so the two cannot disagree about which mode this is.
    return DEV_SERVER ? url.origin === new URL(DEV_SERVER).origin : url.protocol === "file:";
  } catch {
    return false;
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 700,
    minHeight: 520,
    // Shown once it has something to draw, so the window does not flash empty on a slow first paint.
    show: false,
    title: "ZAX",
    // The interface's own favicon, which the renderer build copies out of its `public/`. Set here as well
    // because a window's icon comes from the process, not from the page it happens to be showing.
    icon: join(here, "renderer", "zax.png"),
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.once("ready-to-show", () => window.show());

  // The interface is local; anything else belongs to the browser, not to a window with a preload attached.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    else void logLine(`refused to open ${url}`);
    return { action: "deny" };
  });

  // Navigating away would leave the preload's bridge attached to whatever loaded next, so the window stays on
  // its own content and a web link is handed to the browser instead.
  window.webContents.on("will-navigate", (event, url) => {
    if (isOwnContent(url)) return;
    event.preventDefault();
    if (isWebUrl(url)) void shell.openExternal(url);
    else void logLine(`refused to navigate to ${url}`);
  });

  if (DEV_SERVER) void window.loadURL(DEV_SERVER);
  else void window.loadFile(join(here, "renderer", "index.html"));

  return window;
}

// One instance edits one set of files; a second would let two windows disagree about what is on disk.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (existing) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
    }
  });

  void app.whenReady().then(() => {
    register(createBackend(platform, { chooseFolder }));
    createWindow();
    // macOS keeps the application running with no windows; clicking the dock icon opens one again.
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
