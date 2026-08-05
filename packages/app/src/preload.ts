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
import { BACKEND_METHODS } from "@zax/fallout2/backend-methods";
import type { Backend } from "@zax/fallout2";
import { CHANNEL, GLOBAL } from "./channel.js";

const backend = Object.fromEntries(
  BACKEND_METHODS.map((method) => [method, (...args: unknown[]) => ipcRenderer.invoke(CHANNEL, method, args)]),
) as unknown as Backend;

contextBridge.exposeInMainWorld(GLOBAL, backend);
