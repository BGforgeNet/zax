/**
 * What the window may reach, separated from the window itself so the two decisions run under tests that have
 * no Electron in the room - the same reason the channel's dispatch is its own module.
 *
 * Both answer false for anything they cannot parse: a target that is not a URL is not something to hand
 * outwards or to navigate to either.
 */

/**
 * Whether a target may be handed to the desktop's own handler. Handing it an arbitrary scheme is how a
 * `file://` path or a registered protocol becomes code execution, so only the two a link can legitimately
 * carry are passed on.
 */
export function isWebUrl(target: string): boolean {
  try {
    const { protocol } = new URL(target);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Whether a target is the interface itself: the dev server when one is given, otherwise the built files.
 * Navigating anywhere else would leave the preload's bridge attached to whatever loaded next.
 *
 * `devServer` is passed rather than read here so this makes the same truthiness test the window's own load
 * makes, from the one value, and the two cannot disagree about which mode this is.
 */
export function isOwnContent(target: string, devServer: string | undefined): boolean {
  try {
    const url = new URL(target);
    return devServer ? url.origin === new URL(devServer).origin : url.protocol === "file:";
  } catch {
    return false;
  }
}
