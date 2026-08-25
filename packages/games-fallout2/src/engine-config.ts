/**
 * Where an alternative engine keeps the settings ZAX writes, and whether it has written any of them yet.
 *
 * Two things here are not simply a file's name. fallout2-ce's content config lives under the directory the
 * game's own `[system] master_patches` names, so its path is not known until that file has been read. And an
 * engine writes its configuration the first time it runs, so before that its keys are ZAX's to leave alone:
 * fallout2-ce's imports from `ddraw.ini` and `f2_res.ini` are one-shot and skip on finding exactly the file
 * or section an early write would create, so writing first would silently suppress them.
 */

import {
  IniDocument,
  type ConfigFileContents,
  type ConfigFilePaths,
  type SettingDef,
  type SettingTarget,
} from "@zax/core";
import type { Platform } from "@zax/platform";
import { ENGINES, type EngineDefinition } from "./engines.js";

/** The name settings address fallout2-ce's content config by. Its path is per install. */
const CONTENT_CONFIG = "game#patch.cfg";

/**
 * Where fallout2-ce writes its content config, or null where it writes none. It composes the path itself as
 * `<master_patches>\config\game#patch.cfg` and abandons the whole import when `master_patches` is empty, so a
 * file written anywhere else is one the engine never reads.
 */
export function contentConfigPath(masterPatches: string | undefined): string | null {
  // The game's config spells its paths the way DOS did; the platform seam joins with forward slashes.
  const directory = (masterPatches ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (directory === "") return null;
  return `${directory}/config/${CONTENT_CONFIG}`;
}

/**
 * The engines' own config files reachable in this install, each mapped to where it sits. The content config
 * is left out where `master_patches` names no directory that exists: fallout2-ce refuses to import into one,
 * and creating it here would conjure a game directory the game itself treats as absent.
 *
 * The game's own three files are not here. Their name is their path, which is what `loadConfigFiles` assumes
 * for any name this does not mention.
 */
export async function engineConfigPaths(
  platform: Platform,
  installPath: string,
  gameConfig: string | undefined,
): Promise<ConfigFilePaths> {
  const out: Record<string, string> = { "fission.cfg": "fission.cfg" };
  if (gameConfig === undefined) return out;
  const path = contentConfigPath(IniDocument.parse(gameConfig).get("system", "master_patches"));
  if (path === null) return out;
  const directory = path.slice(0, path.length - `/config/${CONTENT_CONFIG}`.length);
  const there = await platform.fs.stat(platform.paths.join(installPath, directory));
  if (there?.kind === "dir") out[CONTENT_CONFIG] = path;
  return out;
}

/**
 * Whether an engine has written its own settings yet. The test is the engine's settings being present rather
 * than a file existing, because fallout2-ce keeps its own in the game's config file, which every install
 * already has - so its mark is a section vanilla does not carry.
 */
export function hasMintedSettings(engine: EngineDefinition, contents: ConfigFileContents): boolean {
  const held = contents[engine.settingsMark.file];
  if (held === undefined) return false;
  const section = engine.settingsMark.section;
  if (section === undefined) return true;
  return IniDocument.parse(held)
    .sections()
    .some((one) => one.toLowerCase() === section.toLowerCase());
}

/**
 * The addresses one edit actually writes: every target of the setting whose engine has written its own
 * settings, plus every target that belongs to no engine at all.
 *
 * A dormant engine's target is left alone rather than created. Writing it early would put the file or section
 * that engine's own one-shot import checks for into the install, and the import would then never run - the
 * user would lose the settings it was meant to carry across, silently. The target is picked up the next time
 * the install is read, once the engine has run for itself.
 */
export function liveTargets(def: SettingDef, contents: ConfigFileContents): readonly SettingTarget[] {
  return def.targets.filter((target) => {
    if (target.engine === undefined) return true;
    const engine = ENGINES.find((one) => one.id === target.engine);
    return engine !== undefined && hasMintedSettings(engine, contents);
  });
}
