/**
 * Installing a base mod, which ZAX does not perform: it resolves the release, decides eligibility, downloads
 * and verifies, hands the install over to the installer the mod ships, and picks the pieces up afterwards.
 *
 * The two routes are different installs, not two spellings of one. The Windows route is an installer program
 * that takes the game directory as an argument. The other route is a payload extracted over the game with a
 * script inside it that finishes the job - `rpu-install.sh` runs `cd -- "$(dirname "$0")"` and works there,
 * so the extraction is not a step before the install, it is most of the install.
 *
 * One-way by design: there is no uninstall and no unwinding a failure. What ZAX owes instead is that a
 * failure says how far it got and where the installer's own backup went.
 */

import type { GameType, Install } from "@zax/core";
import type { Platform } from "@zax/platform";
import { fnv1a } from "@zax/core";
import { preflightArchive } from "./archive-preflight.js";
import { caseSensitiveAt, mixedCasePaths } from "./case-lowering.js";
import type { ModComponent, ModManifest } from "./manifest.js";
import { chooseFrom } from "./mod-choice.js";
import { fetchAsset, refusalFor, type ModProgress } from "./mod-install.js";
import { modWorkDirectory } from "./mod-transaction.js";
import type { ModRelease } from "./mod-feed.js";
import { assertUsable, loadRecord, type InstallRecord } from "./records.js";

/**
 * What installing a base mod would do, as far as anything but the installer can say. Thinner than a stacking
 * mod's plan on purpose, and the plan says so: the installer decides what lands, so naming files here would
 * be inventing them.
 */
export interface BaseInstallPlan {
  kind: "base";
  version: string;
  /** The asset that installs it, and which of the two routes it takes. */
  asset: string;
  route: "windows" | "other";
  /** What the download needs, from what the release states about the asset. */
  download: number;
  /** What the payload unpacks to, where the route lets ZAX read that before running anything. */
  unpacked?: number;
  /** Free bytes on the game's filesystem, where the host could say. */
  free?: number;
  /** The components chosen, including the ones the manifest marks required. Windows only. */
  components?: readonly string[];
  /**
   * How many entries the case-lowering pass would rename before the install runs. Absent where the pass does
   * not apply - a filesystem that folds case, or an install that is already this mod's.
   */
  lowercasing?: number;
  /** The game type the install reports afterwards. */
  becomes: GameType;
  fingerprint: string;
}

/**
 * Whether this install is already this mod's - a record of it, or a directory that has become what it makes.
 * The second arm is what a hand-installed base mod looks like, which is most of them: upstream's Windows
 * route is the exe installer, and nothing of ZAX was there when it ran.
 */
function isSameInstall(record: InstallRecord, install: Install, manifest: ModManifest): boolean {
  if (record.mods.some((mod) => mod.id === manifest.id && mod.complete)) return true;
  return manifest.becomes !== undefined && install.type === manifest.becomes;
}

/** Every component this install passes to the installer: what was chosen, plus what is always on. */
export function componentsFor(manifest: ModManifest, selection: readonly string[]): readonly ModComponent[] {
  const groups = manifest.installer?.windows?.components ?? [];
  const chosen = chooseFrom(groups, selection, { thing: "component", of: manifest.name });
  const required = groups.flatMap((group) => group.options).filter((option) => option.required);
  const seen = new Set<string>();
  // Declared order, and each once: this list becomes one comma-separated argument, and a name twice in it
  // is a difference the installer could read either way.
  return [...required, ...chosen].filter((option) => (seen.has(option.id) ? false : seen.add(option.id)));
}

/**
 * Resolves what installing this base mod would do, and downloads what it needs to say so - without letting
 * the installer near the game directory.
 *
 * The free-space check happens twice for a reason: before the download it can only know what the release
 * states about the asset, and only after it can the payload's own directory say what it unpacks to. Both are
 * real numbers at the moment they are used, where one guessed multiplier would be neither.
 */
export async function planBaseInstall(
  platform: Platform,
  install: Install,
  release: ModRelease,
  selection: readonly string[] = [],
  options?: ModProgress,
): Promise<BaseInstallPlan> {
  const { manifest } = release;
  if (manifest.type !== "base" || manifest.becomes === undefined)
    throw new Error(`${manifest.name} is not a base mod.`);
  const record = await loadRecord(platform, install.path);
  assertUsable(record, manifest.id);

  const installer = release.installer;
  if (!installer) throw new Error(`${manifest.name} publishes no installer for this system.`);

  // The manifest's own conditions, against the directory as it is now, before a byte is spent on the
  // download. The install runs them again: this one is the cheap answer, not the last word.
  //
  // Not on its own install, though. A base mod's `refuse` rules exist to keep it off a game some other base
  // mod has already changed, and after it has installed, the install answers to those rules itself: UPU
  // refuses over `mods/upu.dat`, which is the file UPU put there. Re-running them on an upgrade would refuse
  // every release after the first.
  const upgrading = isSameInstall(record, install, manifest);
  if (!upgrading) {
    const refusal = await refusalFor(platform, install, release);
    if (refusal !== null) throw new Error(refusal);
  }

  const components = manifest.installer?.windows?.components
    ? componentsFor(manifest, selection).map((component) => component.id)
    : undefined;

  // Before the download rather than after it: the pass can refuse over a pair of colliding names, and that
  // refusal is worth having before an 800 MB transfer rather than after one. The upgrade arm skips it for the
  // reason `mods.md` gives - the tree was lowercased by the first install, and the payload's own
  // deliberately mixed-case files (`mods/AmmoGlovz.ini`) arrived afterwards and are not ZAX's to rename.
  const lowercasing =
    upgrading || !(await caseSensitiveAt(platform, install.path))
      ? undefined
      : (await mixedCasePaths(platform, install.path)).length;

  const download = installer.asset.size ?? 0;
  const free = await platform.fs.freeSpace(install.path);
  if (free !== null && download > 0 && free < download)
    throw new Error(
      `${manifest.name} needs ${download} bytes to download and this drive has ${free} free. Nothing was downloaded.`,
    );

  const work = modWorkDirectory(platform, install, manifest.id);
  const at = await fetchAsset(
    platform,
    work,
    installer.asset,
    { mod: manifest.name, label: `${manifest.name} ${manifest.version}` },
    options,
  );

  // Only the payload route has a directory to read. An installer program is opaque until it runs, which is
  // the cost of delegation and not something to paper over with a guess.
  let unpacked: number | undefined;
  if (installer.route === "other") {
    options?.onStep?.(`Reading ${installer.asset.name}`);
    const entries = await preflightArchive(platform, at, installer.asset.name);
    unpacked = entries.reduce((total, entry) => total + entry.size, 0);
    if (free !== null && free < unpacked)
      throw new Error(
        `${manifest.name} unpacks to ${unpacked} bytes and this drive has ${free} free. Nothing was installed.`,
      );
  }

  return {
    kind: "base",
    version: manifest.version,
    asset: installer.asset.name,
    route: installer.route,
    download,
    ...(unpacked !== undefined ? { unpacked } : {}),
    ...(free !== null ? { free } : {}),
    ...(components !== undefined ? { components } : {}),
    ...(lowercasing !== undefined && lowercasing > 0 ? { lowercasing } : {}),
    becomes: manifest.becomes,
    fingerprint: fnv1a(
      [manifest.version, installer.asset.digest ?? "", installer.route, ...(components ?? [])].join("\n"),
    ),
  };
}
