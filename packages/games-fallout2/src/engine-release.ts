/**
 * What an engine project has published, and the archive that release ships, kept once per machine rather than
 * once per install.
 */

import { compareVersions, packageDirectory } from "@zax/core";
import type { DownloadOptions, Platform } from "@zax/platform";
import { buildFor, engineById, type EngineBuild, type EngineDefinition } from "./engines.js";
import type { InstalledEngine } from "./records.js";

/** One published file: what it is called, where it is, and how big the release says it is. */
export interface EngineAsset {
  name: string;
  url: string;
  size: number;
}

export interface EngineRelease {
  /** The release's tag, as published. */
  release: string;
  /** When it was published, ISO 8601. */
  published: string;
  /** The asset for the machine asking, or null when the project publishes no build it can run. */
  asset: EngineAsset | null;
  /**
   * The commit the tag points at, or null where it could not be read. What actually identifies a rolling
   * build: its tag and its release name never change, so the date and this are all that separate one from
   * the next.
   */
  commit: string | null;
}

/**
 * What a long engine operation reports as it runs. A third alias of the same shape as `SfallProgress` and
 * `ModProgress` rather than a shared one: folding the three together is a refactor of two working flows, and
 * this work has no reason to touch them.
 */
export interface EngineProgress extends DownloadOptions {
  onStep?: (step: string) => void;
}

/**
 * The releases list rather than the `latest` endpoint. A project whose only release is a prerelease - which is
 * what a rolling build is - answers 404 there, and the list's first entry is the newest either way.
 *
 * Thirty is what a version list can usefully offer; a rolling project answers with its one release regardless.
 */
const releasesUrl = (repo: string): string => `https://api.github.com/repos/${repo}/releases?per_page=30`;

/** The singular form, which matches one ref exactly - the plural returns every ref the path is a prefix of. */
const tagUrl = (repo: string, tag: string): string =>
  `https://api.github.com/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;

/**
 * The commit a tag points at, or null for anything that did not resolve to one. Losing it costs a line of
 * description, so a project whose tags this cannot read still installs and updates normally; an annotated tag
 * answers with its own object rather than a commit, and reporting that sha would name a different thing.
 */
async function tagCommit(platform: Platform, repo: string, tag: string): Promise<string | null> {
  try {
    const body: unknown = JSON.parse(await platform.net.fetchText(tagUrl(repo, tag)));
    const object = (body as { object?: unknown } | null)?.object as { sha?: unknown; type?: unknown } | undefined;
    return object?.type === "commit" && typeof object.sha === "string" ? object.sha : null;
  } catch {
    return null;
  }
}

interface PublishedAsset {
  name?: unknown;
  size?: unknown;
  browser_download_url?: unknown;
}

interface PublishedRelease {
  tag_name?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

/** The asset for this machine, or null where the project publishes no build it can run or shipped none. */
function assetIn(entry: PublishedRelease, build: EngineBuild | null): EngineAsset | null {
  if (build === null) return null;
  const declared: unknown = entry.assets;
  const assets = Array.isArray(declared) ? (declared as PublishedAsset[]) : [];
  const wanted = assets.find((asset) => asset.name === build.asset);
  if (!wanted || typeof wanted.browser_download_url !== "string") return null;
  return {
    name: build.asset,
    url: wanted.browser_download_url,
    size: typeof wanted.size === "number" ? wanted.size : 0,
  };
}

/**
 * Every release this machine could install, newest first. Throws where the project has published nothing this
 * version can read, which is what a single unreadable release already did.
 *
 * The commit is resolved only for a rolling project, and costs one request per release. A tagged release is
 * identified by its tag, so asking would spend a request each to display nothing the tag does not already say.
 */
export async function engineReleases(platform: Platform, engineId: string): Promise<readonly EngineRelease[]> {
  const engine = engineById(engineId);
  const body: unknown = JSON.parse(await platform.net.fetchText(releasesUrl(engine.repo)));
  const published = (Array.isArray(body) ? body : []) as PublishedRelease[];
  const build = buildFor(engine, platform.os, platform.arch);

  const releases: EngineRelease[] = [];
  for (const entry of published) {
    const release = typeof entry.tag_name === "string" ? entry.tag_name : "";
    const at = typeof entry.published_at === "string" ? entry.published_at : "";
    if (release === "" || at === "") continue;
    const commit = engine.releases === "rolling" ? await tagCommit(platform, engine.repo, release) : null;
    releases.push({ release, published: at, commit, asset: assetIn(entry, build) });
  }
  if (releases.length === 0) throw new Error(`${engine.name} has published no release ZAX can read.`);
  return releases;
}

/** The newest release. What the Check button reads, and what an update is measured against. */
export async function latestEngine(platform: Platform, engineId: string): Promise<EngineRelease> {
  const [newest] = await engineReleases(platform, engineId);
  // Unreachable: the list above throws rather than come back empty. Bound rather than asserted all the same.
  if (newest === undefined) throw new Error(`${engineById(engineId).name} has published no release ZAX can read.`);
  return newest;
}

/**
 * Whether the installed build is behind the published one. A rolling project publishes no version to compare,
 * so the publication instant is the version; a tagged one compares tags.
 *
 * An instant that will not parse answers false rather than throwing or guessing: this decides whether a button
 * offers an update, and the interface shows both dates beside it either way.
 */
export function engineOutdated(engine: EngineDefinition, installed: InstalledEngine, latest: EngineRelease): boolean {
  if (engine.releases === "tagged") {
    // Every leading non-digit, not just `v`: a tag can carry a word ("beta-0.9.6.4"), and a tag that keeps one
    // falls back to comparing whole strings, which puts 0.9.10 before 0.9.9.
    const strip = (tag: string) => tag.replace(/^\D+/, "");
    return compareVersions(strip(installed.release), strip(latest.release)) < 0;
  }
  const had = Date.parse(installed.published);
  const now = Date.parse(latest.published);
  if (Number.isNaN(had) || Number.isNaN(now)) return false;
  return now > had;
}

/** Path-safe and stable: the instant with its punctuation dropped, which sorts and collides with nothing. */
const releaseKey = (published: string): string => published.replace(/[^0-9]/g, "");

/** One release's directory under the shared package cache. */
const releaseDirectory = (platform: Platform, engine: EngineDefinition, published: string): string =>
  platform.paths.join(packageDirectory(platform), "engines", engine.id, releaseKey(published));

/**
 * What the cache records beside an archive, so a copy already there can be identified without asking the
 * network. The directory name carries the publication instant and nothing else, and a tagged project's tag is
 * what decides whether an install is behind - so the tag and the commit have to be written down.
 */
const NOTE_NAME = "release.json";

/**
 * The cached archive for a release, downloaded if this is the first time it is asked for. Under the shared
 * package directory rather than inside the install, so one download serves every install on the machine.
 *
 * A cached file is trusted only when the release declares a size and the file matches it - an unknown size is
 * not license to trust whatever is already there, which is what a zero-byte file from a broken earlier
 * response would otherwise pass for ever. A mismatch came from an answer that was not the file - an error page
 * served with a 200, a body that stopped early - and is discarded rather than handed out again.
 */
export async function enginePackage(
  platform: Platform,
  engine: EngineDefinition,
  release: EngineRelease,
  asset: EngineAsset,
  options?: EngineProgress,
): Promise<string> {
  const directory = releaseDirectory(platform, engine, release.published);
  const path = platform.paths.join(directory, asset.name);
  const found = await platform.fs.stat(path);
  if (!(found?.kind === "file" && asset.size !== 0 && found.size === asset.size)) {
    await platform.fs.remove(path);

    options?.onStep?.(`Downloading ${engine.name}`);
    await platform.net.download(asset.url, path, options);

    // Confirmed by opening it rather than by magic bytes: engines arrive as .zip, .tar.gz or .dmg, and a disk
    // image has no leading signature to check the way sfall's .7z does.
    try {
      await platform.archive.list(path);
    } catch (error) {
      await platform.fs.remove(path);
      throw new Error(
        `What ${new URL(asset.url).host} sent for ${engine.name} was not an archive - the mirror may have answered with an error page. Trying again may reach a different one.`,
        { cause: error },
      );
    }
  }

  // Written on both routes, and only once the archive is known good: an archive cached by a version that
  // wrote no note is otherwise unidentifiable for ever, since the release it came from is asked for by name
  // and answered from the cache before anything could record what it is.
  const note = { release: release.release, published: release.published, commit: release.commit };
  await platform.fs.write(platform.paths.join(directory, NOTE_NAME), new TextEncoder().encode(JSON.stringify(note)));
  return path;
}

/** A release the cache already holds, with the archive this machine would install it from. */
export interface CachedEngine {
  release: EngineRelease;
  archive: string;
}

/**
 * Every release of this engine already in the cache that this machine could install, newest first. What makes
 * a second game folder a copy rather than a download, and what the Run button's version list offers.
 *
 * A directory with no note is one an older ZAX cached, and is passed over rather than guessed at: it would
 * take a tag and a commit this version cannot recover from the name. Its archive is downloaded again the next
 * time that release is asked for, which writes the note.
 */
export async function cachedEngines(
  platform: Platform,
  engine: EngineDefinition,
  assetName: string,
): Promise<readonly CachedEngine[]> {
  const root = platform.paths.join(packageDirectory(platform), "engines", engine.id);
  if ((await platform.fs.stat(root))?.kind !== "dir") return [];

  const held: CachedEngine[] = [];
  for (const entry of await platform.fs.list(root)) {
    if (entry.kind !== "dir") continue;
    const directory = platform.paths.join(root, entry.name);
    const archive = platform.paths.join(directory, assetName);
    // An empty file is what a download interrupted at the first byte leaves; it is not something to run.
    const found = await platform.fs.stat(archive);
    if (found?.kind !== "file" || found.size === 0) continue;

    const note = await readNote(platform, platform.paths.join(directory, NOTE_NAME));
    if (note === null) continue;
    // No asset: the cache holds the file rather than a way to fetch it, and an invented url is one
    // something downstream would eventually try to download.
    held.push({ release: { ...note, asset: null }, archive });
  }
  // The instants are ISO 8601, so lexical order is chronological - the comparison the note write already relies on.
  return held.sort((a, b) => b.release.published.localeCompare(a.release.published));
}

/** The newest of those, or null where nothing the cache holds can be installed here. */
export async function cachedEngine(
  platform: Platform,
  engine: EngineDefinition,
  assetName: string,
): Promise<CachedEngine | null> {
  return (await cachedEngines(platform, engine, assetName))[0] ?? null;
}

/** The note's fields, or null for anything this version cannot read - a truncated file, or an older format. */
async function readNote(
  platform: Platform,
  path: string,
): Promise<{ release: string; published: string; commit: string | null } | null> {
  if ((await platform.fs.stat(path))?.kind !== "file") return null;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await platform.fs.read(path)));
  } catch {
    // A note ZAX cannot parse is one it did not finish writing. The archive beside it is fetched again.
    return null;
  }
  const fields = body as { release?: unknown; published?: unknown; commit?: unknown };
  if (typeof fields.release !== "string" || typeof fields.published !== "string") return null;
  return {
    release: fields.release,
    published: fields.published,
    commit: typeof fields.commit === "string" ? fields.commit : null,
  };
}
