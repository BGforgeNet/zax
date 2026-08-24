/**
 * Starting the game. What to run and with what environment is Fallout 2 knowledge rather than platform
 * knowledge, so the plan is built here and handed to the platform to run - which also makes it assertable
 * without starting anything.
 */

import { compareVersions } from "@zax/core";
import type { Install } from "@zax/core";
import type { OperatingSystem } from "@zax/platform";

export const EXECUTABLE = "fallout2.exe";

/** The sfall release from which Wine needs the DLL loaded as builtin as well as native. */
const NATIVE_AND_BUILTIN_FROM = "4.1.2";

/**
 * What Wine logs when the install names no channels of its own. Wine's default leaves `err` and `fixme` on, which
 * is a stream of stub notices from a game that runs fine rather than anything diagnostic.
 */
const DEFAULT_DEBUG = "-all";

export interface LaunchPlan {
  program: string;
  args: readonly string[];
  cwd: string;
  /** Added to the inherited environment. Empty on Windows, where the game is started directly. */
  env: Readonly<Record<string, string>>;
}

/**
 * `sfallVersion` is what is installed, or null when no `ddraw.dll` is there. It decides how Wine is told to
 * load that DLL: sfall replaces DirectDraw, and before 4.1.2 loading the builtin alongside the native one broke
 * it. With no sfall installed there is nothing to override, so the variable is left off entirely.
 *
 * `engineProgram` is an installed alternative engine's own program, relative to the install, or null for the
 * game's own executable. An engine is a native build of this system, so it takes no Wine and no DirectDraw
 * override however the install is configured - both would be claims about a process that is not under Wine.
 */
export function planLaunch(
  os: OperatingSystem,
  install: Install,
  sfallVersion: string | null,
  engineProgram: string | null = null,
): LaunchPlan {
  if (engineProgram !== null) {
    // Prefixed off Windows because a bare name is a PATH lookup there, and this program is in the install.
    const program = os === "windows" ? engineProgram : `./${engineProgram}`;
    return { program, args: [], cwd: install.path, env: {} };
  }

  if (os === "windows") return { program: EXECUTABLE, args: [], cwd: install.path, env: {} };

  const overrides =
    sfallVersion === null
      ? {}
      : {
          WINEDLLOVERRIDES:
            compareVersions(sfallVersion, NATIVE_AND_BUILTIN_FROM) < 0 ? "ddraw.dll=n" : "ddraw.dll=n,b",
        };

  return {
    program: "wine",
    args: [EXECUTABLE],
    cwd: install.path,
    env: {
      ...(install.wine?.prefix ? { WINEPREFIX: install.wine.prefix } : {}),
      WINEDEBUG: install.wine?.debug || DEFAULT_DEBUG,
      ...overrides,
    },
  };
}
