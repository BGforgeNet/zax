/**
 * Reading the Windows registry means reading `reg query`'s output, and that parsing is the part worth testing on
 * its own - the spawning around it is not. Kept beside `paths.ts` for the same reason: a pure function of what
 * the host said, rather than of the host.
 */

/**
 * `reg query <key> /v <name>` prints the key, then one indented line per value: name, type, then the data,
 * separated by runs of spaces. Only the first two are single tokens - the data is a path and holds spaces of its
 * own, so it is whatever remains after the type.
 *
 * Names are matched case-insensitively: the registry itself does not distinguish them, so neither can a caller
 * asking for one by name.
 */
export function registryValue(output: string, wanted: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const found = /^\s+(\S+)\s+REG_\w+\s+(.*)$/.exec(line);
    const [, name = "", value = ""] = found ?? [];
    if (found && name.toLowerCase() === wanted.toLowerCase()) {
      const data = value.trim();
      // An empty value is present but says nothing; a caller wanting a path can do nothing with "".
      return data === "" ? null : data;
    }
  }
  return null;
}
