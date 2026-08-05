/**
 * `2026-08-05_18-30-00`: the name every directory and archive this application creates is stamped with. Sorts
 * chronologically in a file manager, and carries no character a filesystem objects to.
 *
 * Taken as an argument everywhere rather than read from the clock, so what a save or a debug package produces
 * is nameable in a test.
 */
export function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("-");
  const time = [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join("-");
  return `${date}_${time}`;
}
