/**
 * The one writer of the log the interface's "open log" button points at. One writer because the file has a
 * format - a timestamp, a level, then the line - and a second place appending to it would drift from that
 * format without anything failing.
 */

import type { Platform } from "@zax/platform";
import { logFile } from "./directories.js";

/**
 * What a line is about. Three rather than the usual half-dozen: the file is read by a person looking for the
 * failure in a bug report, and the only distinction that serves them is whether a line is one.
 */
export type LogLevel = "info" | "warn" | "error";

/**
 * UTF-8, like the application's own state file and unlike the game's config files. Latin-1 is there to
 * round-trip a file ZAX did not write, byte for byte, through an encoding nobody declared; this file is ZAX's
 * own, and a line of it carries install paths and whatever the operating system called a failure. Folding
 * those to one byte a code point writes mojibake into the file a person opens to find out what happened.
 */
const encoder = new TextEncoder();

/**
 * The ceiling, and what survives being trimmed to it. Bounded because nothing else prunes this file: it is
 * appended to for the life of an installation, and the path that writes most of it is a download retrying on
 * a connection that keeps dropping - which is exactly the run whose log matters and exactly the one that
 * grows without limit.
 */
const MAX_BYTES = 1024 * 1024;
const KEEP_BYTES = 512 * 1024;

/**
 * Adds a line, and never throws: this is what reports a failure, so a caller must not have to handle it failing
 * as well. The clock is an argument for the same reason it is in `stamp` - a line is then assertable.
 */
export async function appendLog(platform: Platform, level: LogLevel, text: string, now: Date): Promise<void> {
  try {
    const at = logFile(platform);
    await trim(platform, at, now);
    await platform.fs.append(at, encoder.encode(`${now.toISOString()} ${level.toUpperCase()} ${text}\n`));
  } catch {
    // There is nowhere left to report a failure to write the report.
  }
}

/** Drops the oldest lines once the file is past its ceiling, leaving a note where they were. */
async function trim(platform: Platform, at: string, now: Date): Promise<void> {
  const stat = await platform.fs.stat(at);
  if (stat === null || stat.size <= MAX_BYTES) return;

  const bytes = await platform.fs.read(at);
  // Cut at a newline, which cannot occur inside a UTF-8 sequence, so the surviving bytes still decode. A tail
  // holding no newline is the end of one enormous line, and dropping it whole is the only cut available -
  // keeping it would leave the file over its ceiling and growing.
  const boundary = bytes.indexOf(0x0a, Math.max(0, bytes.length - KEEP_BYTES));
  const from = boundary === -1 ? bytes.length : boundary + 1;
  // Said in the file rather than silently: a person following a failure backwards has to know where the
  // record stops, or they read the oldest surviving line as the beginning of what happened.
  const note = encoder.encode(`${now.toISOString()} INFO log: trimmed, ${from} bytes of older lines dropped\n`);

  const kept = bytes.subarray(from);
  const out = new Uint8Array(note.length + kept.length);
  out.set(note);
  out.set(kept, note.length);
  await platform.fs.write(at, out);
}
