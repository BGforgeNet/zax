/**
 * Where each desktop keeps a per-user config and cache directory. These are the locations the previous
 * implementation used through `appdirs`, reproduced rather than reinvented so an existing `zax.yml` is found
 * where it already sits instead of the application starting over with an empty install list.
 *
 * Takes the home directory and environment rather than reading them, so all three platforms are testable from
 * whichever one happens to be running the tests.
 */
export function userDirectories(
  os: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  appName: string,
): { config: string; cache: string } {
  // Joined with the caller's separator rather than `path.join`, which would use the host's rather than the
  // target's and give a Windows layout with forward slashes when tested from Linux.
  const sep = os === "win32" ? "\\" : "/";
  const at = (...parts: string[]) => parts.join(sep);

  if (os === "win32") {
    const roaming = env["APPDATA"] ?? at(home, "AppData", "Roaming");
    const local = env["LOCALAPPDATA"] ?? at(home, "AppData", "Local");
    return { config: at(roaming, appName), cache: at(local, appName, "Cache") };
  }
  if (os === "darwin") {
    return {
      config: at(home, "Library", "Application Support", appName),
      cache: at(home, "Library", "Caches", appName),
    };
  }
  return {
    config: at(env["XDG_CONFIG_HOME"] ?? at(home, ".config"), appName),
    cache: at(env["XDG_CACHE_HOME"] ?? at(home, ".cache"), appName),
  };
}
