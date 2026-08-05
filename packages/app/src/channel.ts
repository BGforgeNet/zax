/**
 * The one channel the two processes talk over. Both halves import this rather than spelling the string out, so
 * a rename cannot leave one side listening on a name nothing sends to.
 */
export const CHANNEL = "zax:call";

/** What the preload puts on the window, and what the interface looks for. */
export const GLOBAL = "zax";
