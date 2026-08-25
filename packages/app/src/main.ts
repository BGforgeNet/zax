/**
 * The desktop shell. It owns the platform and the window, and answers one channel: the operations the interface
 * is allowed to ask for, dispatched by name.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { appendLog, type LogLevel } from "@zax/core";
import { createBackend, type Backend } from "@zax/fallout2";
import { nodePlatform } from "@zax/platform-node";
import { CHANNEL, PROGRESS_CHANNEL } from "./channel.js";
import { createDispatch, describeError } from "./dispatch.js";
import { isOwnContent, isWebUrl } from "./navigation.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the interface is served from: the built files beside this one, or the dev server when one is given. */
const DEV_SERVER = process.env["ZAX_DEV_SERVER"];

// The platform reports what it did out of sight - failed and resumed downloads above all, which are the one
// thing a bug report from a poor connection cannot reconstruct from the interface. It can be handed `logLine`
// before the line below because a function declaration is hoisted, and `platform` is only read when one is
// written rather than when the sink is passed.
const platform = nodePlatform({ log: (level, line) => void logLine(level, line) });

/** One line per event, in the file the interface's "open log" button points at. */
function logLine(level: LogLevel, text: string): Promise<void> {
  return appendLog(platform, level, text, new Date());
}

// A crash with no window leaves nothing to read; these lines are the only trace a bug report can carry.
process.on("uncaughtException", (error) => void logLine("error", `uncaught: ${describeError(error)}`));
process.on("unhandledRejection", (reason) => void logLine("error", `unhandled rejection: ${describeError(reason)}`));

function register(backend: Backend): void {
  // Every line this sink is handed is an operation that failed; the renderer's notice carries the message and
  // the log carries the stack.
  const dispatch = createDispatch(backend, (line) => void logLine("error", line));
  ipcMain.handle(CHANNEL, (_event, method: string, args: unknown[]) => dispatch(method, args));
}

/**
 * Electron builds a default menu when an application sets none, and on Windows and Linux draws it inside the
 * window - a File, Edit, View and Window bar above the interface's own header. None of it is ZAX's: every
 * entry is either something the interface already offers or something it should not, a devtools toggle and a
 * set of zoom levels among them. It goes.
 *
 * macOS is the exception, and not for appearance - its menu lives in the system bar, and the clipboard
 * shortcuts are routed through it, so an application with no Edit menu is one where Cmd-C and Cmd-V do nothing
 * in any field. It gets the three standard roles and nothing else - the app, edit and window menus macOS
 * expects an application to have, without the rest of what the default would build.
 */
function installMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
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
    // Two things want a floor, and this clears the higher one. The interface drops the sidebar below 820
    // viewport pixels because the settings pane is at its minimum there - and with it goes the only way to
    // switch installs. Above that the sidebar is back but the Settings tab strip needs about 890 to lay its
    // tabs out, and between the two the strip opens already scrolled with its last tab off the edge. The
    // window is a little wider than its viewport, so the floor sits above 890 rather than at it.
    minWidth: 900,
    minHeight: 520,
    // A settings row caps its label, control and notes tracks and gives every surplus pixel to the trailing
    // one, so a wider window shows nothing more - it only pushes each row's revert link further from the
    // setting it reverts. Resizing still works; this is the one-click jump to the whole screen.
    //
    // Windows and macOS only. Electron does not implement `maximizable` on Linux, where whether a window can
    // be maximized is the window manager's to decide and an application does not get a say.
    maximizable: false,
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
    else void logLine("warn", `refused to open ${url}`);
    return { action: "deny" };
  });

  // Navigating away would leave the preload's bridge attached to whatever loaded next, so the window stays on
  // its own content and a web link is handed to the browser instead.
  window.webContents.on("will-navigate", (event, url) => {
    if (isOwnContent(url, DEV_SERVER)) return;
    event.preventDefault();
    if (isWebUrl(url)) void shell.openExternal(url);
    else void logLine("warn", `refused to navigate to ${url}`);
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
    register(
      createBackend(platform, {
        chooseFolder,
        // To whichever window is open. Sent rather than returned because the interface needs it while the
        // operation is still running, and a reply only arrives once it has finished.
        report: (progress) => {
          const [window] = BrowserWindow.getAllWindows();
          if (window && !window.isDestroyed()) window.webContents.send(PROGRESS_CHANNEL, progress);
        },
      }),
    );
    installMenu();
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
