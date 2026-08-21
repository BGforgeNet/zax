/**
 * The one writer of the log the interface's "open log" button points at. One writer because the file has a
 * format - a timestamp, a space, then the line - and a second place appending to it would drift from that
 * format without anything failing.
 */

import type { Platform } from "@zax/platform";
import { logFile } from "./directories.js";

/**
 * UTF-8, like the application's own state file and unlike the game's config files. Latin-1 is there to
 * round-trip a file ZAX did not write, byte for byte, through an encoding nobody declared; this file is ZAX's
 * own, and a line of it carries install paths and whatever the operating system called a failure. Folding
 * those to one byte a code point writes mojibake into the file a person opens to find out what happened.
 */
const encoder = new TextEncoder();

/**
 * Adds a line, and never throws: this is what reports a failure, so a caller must not have to handle it failing
 * as well. The clock is an argument for the same reason it is in `stamp` - a line is then assertable.
 */
export async function appendLog(platform: Platform, text: string, now: Date): Promise<void> {
  try {
    await platform.fs.append(logFile(platform), encoder.encode(`${now.toISOString()} ${text}\n`));
  } catch {
    // There is nowhere left to report a failure to write the report.
  }
}
