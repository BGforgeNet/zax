/**
 * The desktop shell. It owns the platform and the window, and answers one channel: the operations the interface
 * is allowed to ask for, dispatched by name.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BACKEND_METHODS, createBackend, type Backend } from "@zax/fallout2";
import { nodePlatform } from "@zax/platform-node";
import { CHANNEL } from "./channel.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the interface is served from: the built files beside this one, or the dev server when one is given. */
const DEV_SERVER = process.env["ZAX_DEV_SERVER"];

function register(backend: Backend): void {
  const callable = backend as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  ipcMain.handle(CHANNEL, async (_event, method: string, args: unknown[]) => {
    // Only the named operations, and only by exact name: a renderer asking for anything else gets an error
    // rather than a lookup on the object's prototype.
    if (!(BACKEND_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown operation: ${method}`);
    return callable[method]!(...args);
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
    void shell.openExternal(url);
    return { action: "deny" };
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
    register(createBackend(nodePlatform(), { chooseFolder }));
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
