import type { Backend, OperationProgress } from "@zax/fallout2";

/** How the interface hears about a long operation's progress, whichever host it is talking to. */
export interface ProgressSource {
  subscribe(listener: (progress: OperationProgress) => void): void;
}

/** How it says one is running, which is what the desktop window asks about before it closes on one. */
export interface BusySink {
  set(what: string | null): void;
}

declare global {
  interface Window {
    /** Installed by the desktop build's preload script. Absent in a browser. */
    zax?: Backend;
    /** Its companion, carrying the one thing that travels the other way. */
    zaxProgress?: ProgressSource;
    /** And the one that travels back. */
    zaxBusy?: BusySink;
  }
}

export const PREVIEW_REASON = "The browser preview has no machine to reach - this needs the desktop build.";
