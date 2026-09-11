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

import type { GameType, Install, MergeConflict } from "@zax/core";
import type { Platform } from "@zax/platform";
import { backupDirectory, fnv1a, stamp } from "@zax/core";
import { holdUserFiles, mergeUserFiles } from "./mod-state.js";
import { CONFIG_FILES } from "./files.js";
import { preflightArchive } from "./archive-preflight.js";
import { caseSensitiveAt, lowercaseTree, mixedCasePaths } from "./case-lowering.js";
import type { ModManifest } from "./manifest.js";
import { fetchAsset, type ModProgress } from "./mod-asset.js";
import { conflictFor } from "./mod-install.js";
import { modWorkDirectory } from "./mod-transaction.js";
import { installerMiss, type ModRelease } from "./mod-feed.js";
import { takeInstallLock, type InstallLock } from "./install-lock.js";
import { assertUsable, loadRecord, saveRecord, type InstallRecord, type InstalledMod } from "./records.js";

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
  options?: ModProgress,
): Promise<BaseInstallPlan> {
  const { manifest } = release;
  if (manifest.type !== "base" || manifest.becomes === undefined)
    throw new Error(`${manifest.name} is not a base mod.`);
  const record = await loadRecord(platform, install.path);
  assertUsable(record, manifest.id);

  const installer = release.installer;
  if (!installer) throw new Error(installerMiss(manifest, release.installerRoute));

  // The manifest's own conditions, against the directory as it is now, before a byte is spent on the
  // download. The install runs them again: this one is the cheap answer, not the last word.
  //
  // Not on its own install, though. A base mod's `refuse` rules exist to keep it off a game some other base
  // mod has already changed, and after it has installed, the install answers to those rules itself: UPU
  // refuses over `mods/upu.dat`, which is the file UPU put there. Re-running them on an upgrade would refuse
  // every release after the first.
  const upgrading = isSameInstall(record, install, manifest);
  if (!upgrading) {
    const refusal = await conflictFor(platform, install, release);
    if (refusal !== null) throw new Error(refusal);
  }

  // Before the download rather than after it: the pass can refuse over a pair of colliding names, and that
  // refusal is worth having before an 800 MB transfer rather than after one. The upgrade arm skips it for the
  // reason `mods.md` gives - the tree was lowercased by the first install, and the payload's own
  // deliberately mixed-case files (`mods/AmmoGlovz.ini`) arrived afterwards and are not ZAX's to rename.
  const lowercasing =
    upgrading || !(await caseSensitiveAt(platform, install.path))
      ? undefined
      : (await mixedCasePaths(platform, install.path)).length;

  // The download lands in ZAX's cache and the payload in the game folder, which on most machines are not the
  // same drive - so each is measured where its bytes actually go. The directory has to exist to be measured.
  const download = installer.asset.size ?? 0;
  const work = modWorkDirectory(platform, install, manifest.id);
  await platform.fs.mkdir(work);
  const room = await platform.fs.freeSpace(work);
  if (room !== null && download > 0 && room < download)
    throw new Error(
      `${manifest.name} needs ${download} bytes to download and this drive has ${room} free. Nothing was downloaded.`,
    );

  const at = await fetchAsset(
    platform,
    work,
    installer.asset,
    { mod: manifest.name, label: `${manifest.name} ${manifest.version}` },
    options,
  );

  // Read after the download rather than before it: where the cache and the game folder do share a drive, the
  // archive that has just landed on it is room the unpack no longer has.
  const free = await platform.fs.freeSpace(install.path);

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
    ...(lowercasing !== undefined && lowercasing > 0 ? { lowercasing } : {}),
    becomes: manifest.becomes,
    fingerprint: fnv1a([manifest.version, installer.asset.digest ?? "", installer.route].join("\n")),
  };
}

/**
 * The command line for an Inno installer: aimed at this install, logging where ZAX can read it, and leaving
 * every other decision to the wizard.
 *
 * Deliberately not silent, and deliberately naming no components. `/COMPONENTS` replaces the selection rather
 * than adding to it - it selects a custom type and deselects everything it does not name - so passing it at
 * all means ZAX holding a copy of the component tree out of upstream's `inno.iss`, which nothing verifies and
 * which goes stale against the next release in the direction of silently installing less than the user asked
 * for. Letting the wizard open reads that tree out of the executable the user just downloaded instead. What it
 * costs is the directory page, which `/DIR` already answers, and a click-through.
 */
export function innoArguments(installPath: string, log: string): readonly string[] {
  return [`/DIR=${installPath}`, `/LOG=${log}`, "/NORESTART"];
}

/**
 * The two exit codes Inno documents for a user who stopped the wizard themselves, and they are not one case:
 * 2 is cancelled before the install began, 5 is cancelled part way through it. What separates them is whether
 * anything of the mod is on disk, which decides both what the user is told and whether the unfinished record
 * stays behind for a later run to offer a retry over.
 *
 * Reachable only now that the wizard is shown. Read as cancellation on the Inno route alone: the other route
 * runs upstream's shell script, where these numbers are that script's to define and mean nothing here.
 */
const INNO_CANCELLED_BEFORE = 2;
const INNO_CANCELLED_DURING = 5;

/** What a finished base install leaves the caller to act on. */
export interface BaseInstallOutcome {
  version: string;
  /** What the install now is - the caller re-reads the directory to confirm it. */
  becomes: GameType;
  /** How many entries the case-lowering pass renamed before the installer ran. */
  renamed: number;
  /** Settings both the user and the release changed; the user's won. */
  conflicts: readonly MergeConflict[];
  /** Where the installer keeps its own copy of what it moved aside. */
  backup: string;
}

const insidePath = (platform: Platform, root: string, relative: string): string =>
  platform.paths.join(root, ...relative.split("/"));

/**
 * Runs the installer the mod ships, and does everything around it that the installer does not.
 *
 * One-way: there is nothing to unwind here, so a failure says how far it got rather than pretending it can
 * put the directory back. The record is written incomplete before the installer starts and complete after it
 * finishes, so a relaunch that finds an unfinished base install can say so instead of guessing.
 */
export async function applyBaseInstall(
  platform: Platform,
  install: Install,
  release: ModRelease,
  options?: ModProgress,
  now: Date = new Date(),
): Promise<BaseInstallOutcome> {
  const { manifest } = release;
  const becomes = manifest.becomes;
  if (manifest.type !== "base" || becomes === undefined) throw new Error(`${manifest.name} is not a base mod.`);
  const installer = release.installer;
  if (!installer) throw new Error(installerMiss(manifest, release.installerRoute));

  // Claimed after those two refusals rather than before them: a directory must not be held for an operation
  // that was never going to run. Claimed before anything is read, let alone written. An installer from a run that never finished is the
  // one writer nothing else here can see: it is upstream's program, it outlives the ZAX that started it, and
  // the retry this function performs would put a second one over the top of it.
  const claim = await takeInstallLock(platform, install.path, `Installing ${manifest.name}`);
  if ("refused" in claim) throw new Error(claim.refused);
  try {
    return await installUnderLock(platform, install, release, becomes, claim, options, now);
  } finally {
    await claim.release();
  }
}

/**
 * The install itself, with the directory already claimed. Split out so the claim is released on every way out
 * of it, the throws included - there are several, and each leaves the folder part way through.
 */
async function installUnderLock(
  platform: Platform,
  install: Install,
  release: ModRelease,
  /** Narrowed by the caller, which refuses a manifest without one before any of this is reached. */
  becomes: GameType,
  claim: InstallLock,
  options: ModProgress | undefined,
  now: Date,
): Promise<BaseInstallOutcome> {
  const { manifest } = release;
  const installer = release.installer;
  if (!installer) throw new Error(installerMiss(manifest, release.installerRoute));

  // The claim passes to the installer the moment it starts, because from here the installer is the writer and
  // it is the one that outlives ZAX. Not awaited: `run` reports the id rather than waiting on what a caller
  // does with it, and a claim still naming ZAX is the state this improves on rather than a worse one.
  const hold =
    (command: string) =>
    (pid: number): void =>
      void claim.handOver(pid, command);

  const record = await loadRecord(platform, install.path);
  assertUsable(record, manifest.id);
  const previous = record.mods.find((mod) => mod.id === manifest.id && mod.complete);
  const upgrading = isSameInstall(record, install, manifest);
  if (!upgrading) {
    const refusal = await conflictFor(platform, install, release);
    if (refusal !== null) throw new Error(refusal);
  }

  // The user's files, before anything runs: copied to the timestamped backup as every destructive path here
  // does, and held in memory because the installer is about to write over them. A base mod deploys its own
  // sfall and hi-res patch, so without this an install would reset two of ZAX's settings tabs.
  const backup = platform.paths.join(backupDirectory(platform), stamp(now));
  const mine = await holdUserFiles(platform, install.path, CONFIG_FILES, backup);

  // Before the payload lands, and on a first install only: what arrives with the mod is spelled the way the
  // mod spells it, and `mods/AmmoGlovz.ini` is upstream's file rather than something to rename.
  let renamed = 0;
  if (!upgrading && (await caseSensitiveAt(platform, install.path))) {
    options?.onStep?.("Lowercasing the game folder");
    renamed = (await lowercaseTree(platform, install.path)).length;
  }

  const pending: InstalledMod = {
    id: manifest.id,
    version: manifest.version,
    type: "base",
    complete: false,
    // Empty on purpose, and not an omission: the installer decides what lands, so a list here would be
    // invented. It is also what makes a base mod unremovable in fact as well as by its type.
    files: [],
    manifest: release.manifestText,
    shipped: {},
  };
  await saveRecord(platform, withBase(record, pending));

  const work = modWorkDirectory(platform, install, manifest.id);
  const at = platform.paths.join(work, installer.asset.name);
  options?.onStep?.(`Installing ${manifest.name} ${manifest.version}`);

  let outcome;
  if (installer.route === "other") {
    // The payload is the install: `rpu-install.sh` works in the directory it sits in, so extracting over the
    // game directory is most of what the mod does, and the script finishes it.
    await platform.archive.extract(at, install.path);
    const run = manifest.installer?.other?.run;
    // Unreachable while the route came from the manifest this release carries; kept because the two are
    // resolved apart, and a route without its script is not something to half-run.
    if (run === undefined) throw new Error(`${manifest.name} names no installer script for this system.`);
    const script = insidePath(platform, install.path, run);
    // A script out of an archive may arrive without its mode, and one that cannot be executed is an install
    // that cannot happen. Run directly rather than through a named shell: its own shebang picks the
    // interpreter, and nothing here has to guess where that interpreter lives.
    await platform.fs.makeExecutable(script);
    outcome = await platform.process.run(script, [], { cwd: install.path, onStart: hold(script) });
  } else {
    const log = platform.paths.join(work, "installer.log");
    outcome = await platform.process.run(at, innoArguments(install.path, log), {
      cwd: install.path,
      onStart: hold(at),
    });
  }

  const installerBackup = insidePath(platform, install.path, "backup");
  if (outcome.code !== 0) {
    // Cancelling is an answer, not a fault, so it is said as one - and only for the route whose exit codes
    // mean this. Before the install began, the record of an install that never started goes with it: leaving
    // one would have the next run offer to resume something the user declined, over a folder holding none of
    // it. Cancelled part way through falls through to the sentence below, which is exactly what happened.
    if (installer.route === "windows" && outcome.code === INNO_CANCELLED_BEFORE) {
      await saveRecord(platform, withoutBase(await loadRecord(platform, install.path), manifest.id));
      throw new Error(`${manifest.name}'s installer was cancelled, so nothing of it was installed.`);
    }
    const cancelled = installer.route === "windows" && outcome.code === INNO_CANCELLED_DURING;
    // Reported, not unwound. What ZAX can say is how far it got and where the installer put what it moved.
    throw new Error(
      `${manifest.name}'s installer ${cancelled ? "was cancelled part way through" : `stopped with code ${outcome.code ?? "no exit code"}`}. The game folder is part way through the install and ZAX cannot undo it - what the installer moved aside is under ${installerBackup}.${
        !cancelled && outcome.output.trim() ? ` It said: ${outcome.output.trim().split("\n").slice(-3).join(" ")}` : ""
      }`,
    );
  }

  // After the installer rather than before it, which is the one thing that differs from a stacking mod: the
  // installer owns writing these files, so the user's values go back in once it has written them.
  const { shipped, conflicts } = await mergeUserFiles(platform, install.path, CONFIG_FILES, mine, previous?.shipped);

  await saveRecord(
    platform,
    withBase(await loadRecord(platform, install.path), { ...pending, complete: true, shipped }),
  );
  await platform.fs.remove(work);
  return { version: manifest.version, becomes, renamed, conflicts, backup: installerBackup };
}

function withBase(record: InstallRecord, mod: InstalledMod): InstallRecord {
  // Spread, so the entries this version could not read survive an install of something else entirely.
  return { ...record, mods: [...record.mods.filter((held) => held.id !== mod.id), mod] };
}

/** The same record with this mod's entry gone - what a cancelled install leaves, having deployed nothing. */
function withoutBase(record: InstallRecord, id: string): InstallRecord {
  return { ...record, mods: record.mods.filter((held) => held.id !== id) };
}
