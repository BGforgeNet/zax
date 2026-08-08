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
 */
export function planLaunch(os: OperatingSystem, install: Install, sfallVersion: string | null): LaunchPlan {
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
      ...(install.wine?.debug ? { WINEDEBUG: install.wine.debug } : {}),
      ...overrides,
    },
  };
}
