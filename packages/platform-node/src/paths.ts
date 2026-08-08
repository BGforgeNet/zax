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

/**
 * The directory a copy was launched from, which is where a portable one keeps its settings.
 *
 * Both portable formats hide the executable that is actually running: a Windows portable build unpacks itself
 * into a temporary directory, and an AppImage mounts itself read-only somewhere under `/tmp`. Each says where it
 * really came from in the environment, and `process.execPath` would name the hiding place instead. Failing
 * those it is the executable's own directory, less the bundle a macOS application is wrapped in - settings
 * belong beside `ZAX.app`, not buried inside it where a user moving the application would lose them.
 */
export function launchDirectory(
  os: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  execPath: string,
): string {
  const sep = os === "win32" ? "\\" : "/";
  const up = (path: string, levels: number) => path.split(sep).slice(0, -levels).join(sep);

  const portable = env["PORTABLE_EXECUTABLE_DIR"];
  if (portable) return portable;
  const appImage = env["APPIMAGE"];
  if (appImage) return up(appImage, 1);
  // `ZAX.app/Contents/MacOS/ZAX` - four levels up is the directory holding the bundle.
  if (os === "darwin" && execPath.includes(".app/Contents/MacOS/")) return up(execPath, 4);
  return up(execPath, 1);
}

/**
 * The directory a portable copy keeps everything in, or null for an installed one.
 *
 * A `data` directory beside the executable is what turns a copy portable, which is the convention a user
 * carrying an application on a stick already knows from other applications. It has to be created deliberately -
 * an installed copy must not become portable because something wrote a directory of that name - so its presence
 * is the whole switch, and `ZAX_DATA_DIR` names one somewhere else for anyone scripting it.
 */
export function portableDirectory(
  os: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  launchedFrom: string,
  isDirectory: (path: string) => boolean,
): string | null {
  const named = env["ZAX_DATA_DIR"];
  if (named) return named;
  const beside = [launchedFrom, "data"].join(os === "win32" ? "\\" : "/");
  return isDirectory(beside) ? beside : null;
}

/**
 * Where this copy keeps its config and cache: under the portable data directory when there is one, and in the
 * per-user locations otherwise. Separate directories under it either way, so emptying the cache cannot reach
 * the install list.
 *
 * Composes the three rules above rather than leaving the caller to, because the order they go in is the part
 * that has no type to catch it getting wrong - every one of them takes and returns a path.
 */
export function applicationDirectories(
  os: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  appName: string,
  execPath: string,
  isDirectory: (path: string) => boolean,
): { config: string; cache: string } {
  const portable = portableDirectory(os, env, launchDirectory(os, env, execPath), isDirectory);
  if (portable === null) return userDirectories(os, env, home, appName);
  const sep = os === "win32" ? "\\" : "/";
  return { config: [portable, "config"].join(sep), cache: [portable, "cache"].join(sep) };
}
