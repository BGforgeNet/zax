/**
 * The one writer of the log the interface's "open log" button points at. One writer because the file has a
 * format - a timestamp, a space, then the line - and a second place appending to it would drift from that
 * format without anything failing.
 */

import type { Platform } from "@zax/platform";
import { logFile } from "./directories.js";

/** One byte per code point, matching how the rest of the application turns text into bytes. */
function bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/**
 * Adds a line, and never throws: this is what reports a failure, so a caller must not have to handle it failing
 * as well. The clock is an argument for the same reason it is in `stamp` - a line is then assertable.
 */
export async function appendLog(platform: Platform, text: string, now: Date): Promise<void> {
  try {
    await platform.fs.append(logFile(platform), bytes(`${now.toISOString()} ${text}\n`));
  } catch {
    // There is nowhere left to report a failure to write the report.
  }
}
