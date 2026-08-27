/**
 * The one channel the two processes talk over. Both halves import this rather than spelling the string out, so
 * a rename cannot leave one side listening on a name nothing sends to.
 */
export const CHANNEL = "zax:call";

/**
 * The other direction, and the only thing that travels it: how far a long operation has got. A reply cannot
 * carry this - the interface needs it while the call is still running, not when it returns.
 */
export const PROGRESS_CHANNEL = "zax:progress";

/**
 * The other direction again: what long operation the interface has running, or null when it has none. The window
 * asks before closing on one. The renderer has to say - the main process can see a call in flight, but not
 * whether ending it would cost the user anything.
 */
export const BUSY_CHANNEL = "zax:busy";

/** What the preload puts on the window, and what the interface looks for. */
export const GLOBAL = "zax";

/**
 * Progress is exposed separately rather than as another member of the backend, because the backend is built
 * from the operation list and a member that is not an operation would put the two out of step.
 */
export const PROGRESS_GLOBAL = "zaxProgress";

/** Its counterpart, and separate from the backend for the same reason. */
export const BUSY_GLOBAL = "zaxBusy";
