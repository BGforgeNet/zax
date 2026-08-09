/**
 * The renderer's half of the boundary: one caller per backend operation, each forwarding to the main process.
 *
 * Built from the operation list rather than written out, so the two halves cannot drift - a method added to the
 * backend appears here and in the main process at once, or in neither.
 *
 * The renderer gets no Node access of its own. Everything privileged happens in the main process, and what the
 * page can ask for is exactly the operations named in that list.
 */

import { contextBridge, ipcRenderer } from "electron";
import { fromMethods } from "@zax/fallout2/backend-methods";
import type { OperationProgress } from "@zax/fallout2";
import { CHANNEL, GLOBAL, PROGRESS_CHANNEL, PROGRESS_GLOBAL } from "./channel.js";
import { unwrapped } from "./ipc-error.js";

const backend = fromMethods(
  (method) =>
    (...args: unknown[]) =>
      ipcRenderer.invoke(CHANNEL, method, args).catch((error: unknown) => Promise.reject(unwrapped(error))),
);

contextBridge.exposeInMainWorld(GLOBAL, backend);

// Separate from the backend because it is not one of the operations - see the note on `PROGRESS_GLOBAL`. The
// listener is wrapped rather than passed on, so nothing from the page is ever handed to `ipcRenderer` itself.
contextBridge.exposeInMainWorld(PROGRESS_GLOBAL, {
  subscribe: (listener: (progress: OperationProgress) => void) => {
    ipcRenderer.on(PROGRESS_CHANNEL, (_event, progress: OperationProgress) => listener(progress));
  },
});
