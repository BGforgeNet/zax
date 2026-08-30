/**
 * Selects the real desktop bridge or lazily loads the browser preview machine.
 *
 * Desktop builds use a fixed Vite mode, which makes the preview branch unreachable and keeps its backend,
 * dependencies and fixture data out of the packaged renderer.
 */

import type { Backend } from "@zax/fallout2";
import { PREVIEW_REASON, type BusySink, type ProgressSource } from "./host-contract.js";

export { PREVIEW_REASON };
export type HostKind = "desktop" | "preview";

const supplied = typeof window === "undefined" ? undefined : window.zax;
const preview =
  supplied === undefined && import.meta.env.MODE !== "desktop" ? await import("./preview-host.js") : undefined;

if (supplied === undefined && preview === undefined) {
  throw new Error("The desktop backend bridge is unavailable.");
}
if (supplied !== undefined && (window.zaxProgress === undefined || window.zaxBusy === undefined)) {
  throw new Error("The desktop backend bridge is incomplete.");
}

export const hostKind: HostKind = supplied === undefined ? "preview" : "desktop";
export const backend: Backend = supplied ?? preview!.backend;
export const progressSource: ProgressSource = supplied === undefined ? preview!.progressSource : window.zaxProgress!;
export const busySink: BusySink = supplied === undefined ? preview!.busySink : window.zaxBusy!;
export const isPreview = hostKind === "preview";
