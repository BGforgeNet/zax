/**
 * Electron prefixes a rejected call's message with the channel it came over - "Error invoking remote method
 * 'zax:call': ..." - which the interface would otherwise show to the user in front of the real reason. The
 * messages this application throws are written to be read, so the wrapper is taken back off at the one place
 * that put it on.
 */
export function unwrapped(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);
  const cut = /^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/.exec(text);
  return new Error(cut ? text.slice(cut[0].length) : text);
}
