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
 * `ownContent` is the address the window was actually told to load. Development serves a module graph from one
 * origin; a packaged application has one HTML entry point, with only its fragment allowed to vary.
 */
export function isOwnContent(target: string, ownContent: string): boolean {
  try {
    const url = new URL(target);
    const own = new URL(ownContent);
    if (own.protocol !== "file:") return url.origin === own.origin;
    url.hash = "";
    own.hash = "";
    return url.href === own.href;
  } catch {
    return false;
  }
}

interface SenderFrame {
  readonly url: string;
}

/** Only the main frame at the application address receives the authority carried by the preload bridge. */
export function isTrustedIpcSender(
  sender: SenderFrame | null,
  mainFrame: SenderFrame | null,
  ownContent: string,
): boolean {
  return sender !== null && sender === mainFrame && isOwnContent(sender.url, ownContent);
}
