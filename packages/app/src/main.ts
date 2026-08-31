/**
 * The desktop shell. It owns the platform and the window, and answers one channel: the operations the interface
 * is allowed to ask for, dispatched by name.
 */

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { appendLog, type LogLevel } from "@zax/core";
import { createBackend, type Backend } from "@zax/fallout2";
import { nodePlatform } from "@zax/platform-node";
import { BUSY_CHANNEL, CHANNEL, PROGRESS_CHANNEL } from "./channel.js";
import { CLOSE_ANYWAY, busyLabel, closePrompt } from "./closing.js";
import { createDispatch, describeError } from "./dispatch.js";
import { isOwnContent, isTrustedIpcSender, isWebUrl } from "./navigation.js";
import { folderPicked, pickerOptions } from "./picker.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Where the interface is served from: the built files beside this one, or the dev server when one is given. */
const DEV_SERVER = process.env["ZAX_DEV_SERVER"];
const RENDERER = join(here, "renderer", "index.html");
// oxlint-disable-next-line typescript/prefer-nullish-coalescing -- `ZAX_DEV_SERVER=` set to empty means unset.
const OWN_CONTENT = DEV_SERVER || pathToFileURL(RENDERER).href;

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

/** The operation the interface has running, as it last reported. Null once it has none. */
let busy: string | null = null;
ipcMain.on(BUSY_CHANNEL, (event, what: unknown) => {
  if (!isTrustedIpcSender(event.senderFrame, event.sender.mainFrame, OWN_CONTENT)) {
    void logLine("warn", "refused a busy message from outside the application");
    return;
  }
  busy = busyLabel(what);
});

function register(backend: Backend): void {
  // Every line this sink is handed is an operation that failed; the renderer's notice carries the message and
  // the log carries the stack.
  const dispatch = createDispatch(backend, (line) => void logLine("error", line));
  ipcMain.handle(CHANNEL, (event, method: string, args: unknown[]) => {
    if (!isTrustedIpcSender(event.senderFrame, event.sender.mainFrame, OWN_CONTENT)) {
      void logLine("warn", "refused a backend request from outside the application");
      throw new Error("The backend request did not come from the application.");
    }
    return dispatch(method, args);
  });
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
 * The folder picker, attached to the window so it is modal to it rather than a stray dialog. Returns null on
 * cancel, which is not a failure: the caller simply has nothing to add. `holding` asks for the folder by way
 * of a file inside it - see `picker.ts`, which holds both ends of that.
 */
async function chooseFolder(holding?: string): Promise<string | null> {
  const [parent] = BrowserWindow.getAllWindows();
  const options = pickerOptions(holding);
  const result = await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options));
  const picked = result.canceled ? null : (result.filePaths[0] ?? null);
  return picked === null ? null : folderPicked(picked, holding);
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

  // A close while an operation is running ends it where it stands, so the window asks first rather than taking
  // the click as the answer. `asking` keeps a second click from stacking a second dialog on the first, and
  // `leaving` lets the answered close through: the window is closed again from here rather than destroyed, so
  // it still unwinds the way any other close does.
  let asking = false;
  let leaving = false;
  window.on("close", (event) => {
    if (busy === null || leaving) return;
    event.preventDefault();
    if (asking) return;
    asking = true;
    void dialog
      .showMessageBox(window, closePrompt(busy))
      .then(({ response }) => {
        asking = false;
        leaving = response === CLOSE_ANYWAY;
        if (leaving) window.close();
      })
      .catch((error: unknown) => {
        // A dialog that could not be shown must not leave a window that cannot be closed.
        asking = false;
        leaving = true;
        void logLine("error", `could not ask about closing: ${describeError(error)}`);
        window.close();
      });
  });

  // A page that has just loaded has nothing running, whatever the page before it last said. Without this a
  // reload during an operation - the dev server's, or a renderer that crashed and came back - would leave the
  // window refusing to close over an operation that no longer exists.
  window.webContents.on("did-finish-load", () => {
    busy = null;
  });

  // The interface is local; anything else belongs to the browser, not to a window with a preload attached.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    else void logLine("warn", `refused to open ${url}`);
    return { action: "deny" };
  });

  // Navigating away would leave the preload's bridge attached to whatever loaded next, so the window stays on
  // its own content and a web link is handed to the browser instead.
  window.webContents.on("will-navigate", (event, url) => {
    if (isOwnContent(url, OWN_CONTENT)) return;
    event.preventDefault();
    if (isWebUrl(url)) void shell.openExternal(url);
    else void logLine("warn", `refused to navigate to ${url}`);
  });

  if (DEV_SERVER) void window.loadURL(DEV_SERVER);
  else void window.loadFile(RENDERER);

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
