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
import { backupDirectory, fnv1a, IniDocument, latin1, mergeIni, stamp } from "@zax/core";
import { CONFIG_FILES } from "./files.js";
import { preflightArchive } from "./archive-preflight.js";
import { caseSensitiveAt, lowercaseTree, mixedCasePaths } from "./case-lowering.js";
import type { ModComponent, ModManifest } from "./manifest.js";
import { chooseFrom } from "./mod-choice.js";
import { fetchAsset, type ModProgress } from "./mod-asset.js";
import { refusalFor } from "./mod-install.js";
import { modWorkDirectory } from "./mod-transaction.js";
import type { ModRelease } from "./mod-feed.js";
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

  // Only where this host runs the installer that has them. The zip route ships every optional dat and takes
  // no component argument, so naming a component in its plan would name something that changes nothing.
  const components =
    installer.route === "windows" && manifest.installer?.windows?.components
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

/** Inno's own switches, from its documented command line. Read once, spelled here, verified against the docs. */
const INNO_SILENT = ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"];

/**
 * The command line for an Inno installer: silent, aimed at this install, logging where ZAX can read it, and
 * naming every component to select.
 *
 * `/COMPONENTS` selects a custom type and deselects everything it does not name, so the list has to be
 * complete rather than a diff from the default - which is why the manifest marks its required components and
 * why an ancestor is passed with its child: `walk_speed\low_fps` is Inno's own spelling for a component
 * inside `walk_speed`, and a child arrives with its parent selected in the wizard too.
 */
export function innoArguments(installPath: string, log: string, components?: readonly string[]): readonly string[] {
  const selected = new Set<string>();
  for (const id of components ?? []) {
    const pieces = id.split("\\");
    for (let at = 1; at <= pieces.length; at++) selected.add(pieces.slice(0, at).join("\\"));
  }
  return [
    ...INNO_SILENT,
    `/DIR=${installPath}`,
    `/LOG=${log}`,
    ...(selected.size > 0 ? [`/COMPONENTS=${[...selected].join(",")}`] : []),
  ];
}

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

/**
 * The files that belong to the user across a base install: what the manifest declares, or the engine's own
 * config files, which are the ones ZAX's settings tabs edit. A base mod deploys its bundled sfall and hi-res
 * patch, so without this an install would silently reset two tabs' worth of the user's settings.
 */
async function stateFilesFor(platform: Platform, install: Install, manifest: ModManifest): Promise<readonly string[]> {
  const declared = manifest.state ?? [...CONFIG_FILES];
  const held: string[] = [];
  for (const path of declared) {
    if ((await platform.fs.stat(insidePath(platform, install.path, path)))?.kind === "file") held.push(path);
  }
  return held;
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
  plan: BaseInstallPlan,
  options?: ModProgress,
  now: Date = new Date(),
): Promise<BaseInstallOutcome> {
  const { manifest } = release;
  if (manifest.type !== "base" || manifest.becomes === undefined)
    throw new Error(`${manifest.name} is not a base mod.`);
  const installer = release.installer;
  if (!installer) throw new Error(`${manifest.name} publishes no installer for this system.`);

  const record = await loadRecord(platform, install.path);
  assertUsable(record, manifest.id);
  const previous = record.mods.find((mod) => mod.id === manifest.id && mod.complete);
  const upgrading = isSameInstall(record, install, manifest);
  if (!upgrading) {
    const refusal = await refusalFor(platform, install, release);
    if (refusal !== null) throw new Error(refusal);
  }

  // The user's files, before anything runs: copied to the timestamped backup as every destructive path here
  // does, and held in memory because the installer is about to write over them.
  const backup = platform.paths.join(backupDirectory(platform), stamp(now));
  const stateFiles = await stateFilesFor(platform, install, manifest);
  const mine = new Map<string, Uint8Array>();
  for (const path of stateFiles) {
    const at = insidePath(platform, install.path, path);
    const bytes = await platform.fs.read(at);
    mine.set(path, bytes);
    await platform.fs.copy(at, insidePath(platform, backup, path));
  }

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
    outcome = await platform.process.run(script, [], { cwd: install.path });
  } else {
    const log = platform.paths.join(work, "installer.log");
    outcome = await platform.process.run(at, innoArguments(install.path, log, plan.components), {
      cwd: install.path,
    });
  }

  const installerBackup = insidePath(platform, install.path, "backup");
  if (outcome.code !== 0) {
    // Reported, not unwound. What ZAX can say is how far it got and where the installer put what it moved.
    throw new Error(
      `${manifest.name}'s installer stopped with code ${outcome.code ?? "no exit code"}. The game folder is part way through the install and ZAX cannot undo it - what the installer moved aside is under ${installerBackup}.${
        outcome.output.trim() ? ` It said: ${outcome.output.trim().split("\n").slice(-3).join(" ")}` : ""
      }`,
    );
  }

  // After the installer rather than before it, which is the one thing that differs from a stacking mod: the
  // installer owns writing these files, so the user's values go back in once it has written them.
  const conflicts: MergeConflict[] = [];
  const shipped: Record<string, string> = {};
  for (const path of stateFiles) {
    const target = insidePath(platform, install.path, path);
    if ((await platform.fs.stat(target))?.kind !== "file") continue;
    const shippedBytes = await platform.fs.read(target);
    shipped[path] = latin1(shippedBytes);
    const held = mine.get(path);
    if (!held) continue;
    const base = previous?.shipped[path];
    const merged = mergeIni(
      IniDocument.parseBytes(shippedBytes),
      IniDocument.parseBytes(held),
      base === undefined ? null : IniDocument.parse(base),
    );
    await platform.fs.write(target, merged.document.toBytes());
    conflicts.push(...merged.conflicts);
  }

  await saveRecord(
    platform,
    withBase(await loadRecord(platform, install.path), { ...pending, complete: true, shipped }),
  );
  await platform.fs.remove(work);
  return { version: manifest.version, becomes: manifest.becomes, renamed, conflicts, backup: installerBackup };
}

function withBase(record: InstallRecord, mod: InstalledMod): InstallRecord {
  // Spread, so the entries this version could not read survive an install of something else entirely.
  return { ...record, mods: [...record.mods.filter((held) => held.id !== mod.id), mod] };
}
