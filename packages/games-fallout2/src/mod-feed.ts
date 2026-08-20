/**
 * Where mods come from, and whether this install can take them.
 *
 * The feed list ships in code, reviewable and changed only by a ZAX release, never fetched from somewhere
 * writable - installing a mod is trusting its publisher, and this list is where that trust is granted. A feed
 * entry names a repository and the mod id it follows; two entries may share a repository and each takes the
 * newest release whose manifest carries its id, which is how parallel release lines interleave in one list.
 *
 * A release describes itself two ways. It may publish the manifest as an asset, stamped by CI with the
 * version and the payload's name; or it may publish only the payload, and the manifest is read from the
 * repository at the release's tag - the tag supplies the version, the sole archive asset the payload. The
 * second route costs a mod author no build step at all, which is most of them.
 *
 * GitHub allows an unauthenticated address 60 API requests an hour, shared with the update check, so the
 * release listing is cached with a short life and a stale copy answers when the network cannot. A release's
 * manifest asset is immutable once published and is kept for good.
 */

import { compareVersions, GAME_TYPES, type Install } from "@zax/core";
import { NetworkError, type Platform } from "@zax/platform";
import { MANIFEST_NAME, isModVersion, parseManifest, type ModManifest } from "./manifest.js";
import type { InstallRecord } from "./records.js";
import { MODS_DIRECTORY, answersToId } from "./mods.js";

export interface ModFeed {
  /** `owner/name`, the repository whose releases are read. */
  repository: string;
  /** The manifest id this entry follows through that repository's releases. */
  id: string;
}

export const MOD_FEEDS: readonly ModFeed[] = [{ repository: "BGforgeNet/FO2tweaks", id: "fo2tweaks" }];

/** One release as ZAX holds it: the parsed manifest, its exact bytes, and where the payload is. */
export interface ModRelease {
  manifest: ModManifest;
  /** The manifest's text as fetched - what the archive's embedded copy must match byte for byte. */
  manifestText: string;
  /**
   * Whether the release published the manifest itself. False means it was read from the repository at the
   * tag, where the payload cannot be expected to carry a copy - so only a published manifest makes an archive
   * without one a refusal.
   */
  manifestFromAsset: boolean;
  /** The payload asset the manifest names, with what the release states about it. */
  archive?: { name: string; url: string; digest?: string; size?: number };
}

const FEED_CACHE_MS = 30 * 60 * 1000;

const slug = (text: string): string => text.replace(/[^\w.-]+/g, "-");

const feedsDirectory = (platform: Platform): string => platform.paths.join(platform.paths.cache, "feeds");

/** GitHub's release feed for a repository, newest first. */
const releasesUrl = (repository: string): string => `https://api.github.com/repos/${repository}/releases?per_page=30`;

interface ReleaseAsset {
  name: string;
  url: string;
  digest?: string;
  size?: number;
}

interface FeedRelease {
  tag: string;
  assets: readonly ReleaseAsset[];
}

function readReleases(body: string): FeedRelease[] {
  const raw: unknown = JSON.parse(body);
  if (!Array.isArray(raw)) return [];
  const out: FeedRelease[] = [];
  for (const entry of raw) {
    const release = entry as { tag_name?: unknown; assets?: unknown };
    if (typeof release.tag_name !== "string") continue;
    const assets: ReleaseAsset[] = [];
    for (const item of Array.isArray(release.assets) ? release.assets : []) {
      const asset = item as { name?: unknown; browser_download_url?: unknown; digest?: unknown; size?: unknown };
      if (typeof asset.name !== "string" || typeof asset.browser_download_url !== "string") continue;
      assets.push({
        name: asset.name,
        url: asset.browser_download_url,
        // GitHub states `sha256:<hex>`; kept verbatim and split where it is checked.
        ...(typeof asset.digest === "string" ? { digest: asset.digest } : {}),
        ...(typeof asset.size === "number" ? { size: asset.size } : {}),
      });
    }
    out.push({ tag: release.tag_name, assets });
  }
  return out;
}

/**
 * The repository's releases, from the cache while it is fresh, the network when it is not, and the stale
 * cache again when the network refuses - a listing that worked yesterday beats an empty tab today, and the
 * install path re-verifies everything that matters against digests anyway.
 */
async function fetchReleases(platform: Platform, repository: string, now: Date): Promise<FeedRelease[]> {
  const cachePath = platform.paths.join(feedsDirectory(platform), `${slug(repository)}.json`);
  const cached = await platform.fs.stat(cachePath);
  if (cached?.kind === "file" && now.getTime() - cached.modified < FEED_CACHE_MS) {
    return readReleases(new TextDecoder().decode(await platform.fs.read(cachePath)));
  }
  let body: string;
  try {
    body = await platform.net.fetchText(releasesUrl(repository));
  } catch (error) {
    if (error instanceof NetworkError && cached?.kind === "file") {
      return readReleases(new TextDecoder().decode(await platform.fs.read(cachePath)));
    }
    throw error;
  }
  await platform.fs.write(cachePath, new TextEncoder().encode(body));
  return readReleases(body);
}

/** The manifest as committed, at the tag the release names - the route that costs an author no build step. */
const repositoryManifestUrl = (repository: string, tag: string): string =>
  `https://raw.githubusercontent.com/${repository}/${tag}/${MANIFEST_NAME}`;

/** Payload assets ZAX can open. Anything else on a release - checksums, signatures, notes - is not a payload. */
const ARCHIVE_SUFFIXES = [".zip", ".7z", ".rar", ".tar.gz", ".tgz", ".tar"];

/**
 * The payload when the manifest does not name one: a release's sole archive-shaped asset. Two of them is an
 * ambiguity only the author can settle, so the manifest's `archive` stays in the format for that case.
 */
function soleArchive(assets: readonly ReleaseAsset[]): ReleaseAsset | undefined {
  const archives = assets.filter(
    (asset) => asset.name !== MANIFEST_NAME && ARCHIVE_SUFFIXES.some((end) => asset.name.toLowerCase().endsWith(end)),
  );
  return archives.length === 1 ? archives[0] : undefined;
}

/** A tag's version: `v14.7` is 14.7. A tag shaped like anything else names no version and is passed over. */
function versionFromTag(tag: string): string | undefined {
  const version = tag.replace(/^v/i, "");
  return isModVersion(version) ? version : undefined;
}

interface FetchedManifest {
  text: string;
  fromAsset: boolean;
}

/**
 * A release's manifest, fetched once - neither a published asset nor a tagged tree changes afterwards. The
 * repository route is tried only when the release publishes no manifest, and its absence is kept too: a
 * repository that ships none would otherwise cost one request per release on every listing refresh.
 */
async function fetchManifestText(
  platform: Platform,
  repository: string,
  release: FeedRelease,
): Promise<FetchedManifest | null> {
  const asset = release.assets.find((entry) => entry.name === MANIFEST_NAME);
  const fromAsset = asset !== undefined;
  const base = platform.paths.join(feedsDirectory(platform), `${slug(repository)}-${slug(release.tag)}`);
  const kept = `${base}.yml`;
  if ((await platform.fs.stat(kept))?.kind === "file")
    return { text: new TextDecoder().decode(await platform.fs.read(kept)), fromAsset };
  const missing = `${base}.none`;
  if (!fromAsset && (await platform.fs.stat(missing))?.kind === "file") return null;

  let text: string;
  try {
    text = await platform.net.fetchText(asset ? asset.url : repositoryManifestUrl(repository, release.tag));
  } catch (error) {
    // A tag with no manifest is a release that is not for ZAX, not a broken feed - every other failure is.
    if (!fromAsset && error instanceof NetworkError && error.status === 404) {
      await platform.fs.write(missing, new Uint8Array());
      return null;
    }
    throw error;
  }
  await platform.fs.write(kept, new TextEncoder().encode(text));
  return { text, fromAsset };
}

/**
 * The current release of a feed's mod: of every release whose manifest carries the followed id, the one with
 * the highest manifest version - release order alone would let a hotfix backported to an older line shadow
 * the current one. The whole listing is walked, which costs the network only for tags not yet seen; each
 * manifest is fetched once ever. A manifest that refuses to parse is remembered rather than skipped
 * silently - when no release matches, the first refusal is the answer, since "this needs a newer ZAX" is
 * truer than "nothing found".
 */
export async function fetchFeed(platform: Platform, feed: ModFeed, now: Date = new Date()): Promise<ModRelease> {
  const releases = await fetchReleases(platform, feed.repository, now);
  let firstRefusal: Error | null = null;
  let sawManifest = false;
  let best: ModRelease | null = null;

  for (const release of releases) {
    const found = await fetchManifestText(platform, feed.repository, release);
    if (found === null) continue;
    sawManifest = true;
    const tagged = versionFromTag(release.tag);
    const inferred = soleArchive(release.assets);
    let manifest: ModManifest;
    try {
      manifest = parseManifest(new TextEncoder().encode(found.text), {
        ...(tagged !== undefined ? { version: tagged } : {}),
        ...(inferred !== undefined ? { archive: inferred.name } : {}),
      });
    } catch (error) {
      firstRefusal ??= error instanceof Error ? error : new Error(String(error));
      continue;
    }
    if (manifest.id !== feed.id) continue;
    // Strictly higher, so a version published twice keeps its newest release's assets.
    if (best !== null && compareVersions(manifest.version, best.manifest.version) <= 0) continue;
    const archive = manifest.archive ? release.assets.find((asset) => asset.name === manifest.archive) : undefined;
    best = { manifest, manifestText: found.text, manifestFromAsset: found.fromAsset, ...(archive ? { archive } : {}) };
  }

  if (best !== null) return best;
  if (firstRefusal) throw firstRefusal;
  throw new Error(
    sawManifest
      ? `No release of ${feed.repository} carries a manifest for "${feed.id}".`
      : `No release of ${feed.repository} ships a ZAX manifest yet.`,
  );
}

/** What the interface offers for one mod on one install, decided from what is already known. */
export type Availability =
  | { kind: "install" }
  /** Present without a record - hand-installed - so the offer is the latest release laid over it. */
  | { kind: "install-over" }
  | { kind: "installed" }
  | { kind: "upgrade"; from: string }
  /** A feed answering with an older version than the record - what a rolled-back feed looks like. */
  | { kind: "downgrade"; from: string }
  /** An install that never finished; the working directory decides between resume and restore. */
  | { kind: "retry"; version: string }
  /** Recorded as installed while no known feed follows the id - still removable, never updatable. */
  | { kind: "unfollowed" }
  | { kind: "blocked"; why: string };

export interface ModContext {
  install: Install;
  record: InstallRecord;
  /** The installed sfall version, or null when the install has none. */
  sfall: string | null;
  /** Whether anything under `mods/` answers to the mod's name - the hand-installed case. */
  present: boolean;
}

export function availability(release: ModRelease, context: ModContext): Availability {
  const { manifest } = release;
  const recorded = context.record.mods.find((mod) => mod.id === manifest.id);

  if (recorded && !recorded.complete) return { kind: "retry", version: recorded.version };

  // The sfall requirement is the new release's and binds upgrades too; the updater answers it either way.
  if (manifest.requiresSfall !== undefined) {
    const held = context.sfall;
    if (held === null || compareVersions(held, manifest.requiresSfall) < 0) {
      const has = held === null ? "none" : held;
      return {
        kind: "blocked",
        why: `${manifest.name} needs sfall ${manifest.requiresSfall} or newer - this install has ${has}. ZAX's sfall updater can raise it first.`,
      };
    }
  }

  if (recorded) {
    const newness = compareVersions(manifest.version, recorded.version);
    if (newness < 0) return { kind: "downgrade", from: recorded.version };
    if (newness === 0) return { kind: "installed" };
  }

  // Everything from here on is an offer to download, which a release that never names its payload cannot make.
  if (!release.archive) {
    return { kind: "blocked", why: `The ${manifest.name} release does not say which of its files is the mod.` };
  }

  if (recorded) return { kind: "upgrade", from: recorded.version };

  // Presence always comes from the directory; a mod there without a record upgrades by installing over.
  if (context.present) return { kind: "install-over" };

  // The game-type gate protects a first install alone - install-over and upgrades are the same mod already.
  if (manifest.installOn !== undefined && !manifest.installOn.includes(context.install.type)) {
    const wanted = manifest.installOn.map((type) => GAME_TYPES[type].name).join(" or ");
    return {
      kind: "blocked",
      why: `${manifest.name} installs on ${wanted} - this install is ${GAME_TYPES[context.install.type].name}.`,
    };
  }

  return { kind: "install" };
}

/** Whether anything in the install's `mods/` answers to the id - `<id>.*` or a folder of that name. */
export async function presentInMods(platform: Platform, installPath: string, id: string): Promise<boolean> {
  const directory = platform.paths.join(installPath, MODS_DIRECTORY);
  if ((await platform.fs.stat(directory))?.kind !== "dir") return false;
  return (await platform.fs.list(directory)).some((entry) => answersToId(entry.name, id));
}

/** One mod as the interface lists it, everything plain enough to cross the process boundary. */
export interface ModOffer {
  id: string;
  name: string;
  version: string;
  type: "pluggable" | "permanent";
  /** A permanent mod's declared reason, standing where the Remove control would be. */
  reason?: string;
  availability: Availability;
}

export interface ModListing {
  offers: readonly ModOffer[];
  /** Feeds that could not answer, each with why - offline, no manifest yet, needs a newer ZAX. */
  failures: readonly { repository: string; id: string; why: string }[];
}

/**
 * Every known mod against one install. A feed that cannot answer costs its own row, not the listing: the
 * other mods are still installable while one repository is unreachable or unadopted.
 */
export async function listAvailableMods(
  platform: Platform,
  install: Install,
  record: InstallRecord,
  sfall: string | null,
  now: Date = new Date(),
): Promise<ModListing> {
  const offers: ModOffer[] = [];
  const failures: { repository: string; id: string; why: string }[] = [];
  for (const feed of MOD_FEEDS) {
    try {
      const release = await fetchFeed(platform, feed, now);
      const present = await presentInMods(platform, install.path, feed.id);
      offers.push({
        id: release.manifest.id,
        name: release.manifest.name,
        version: release.manifest.version,
        type: release.manifest.type,
        ...(release.manifest.reason !== undefined ? { reason: release.manifest.reason } : {}),
        availability: availability(release, { install, record, sfall, present }),
      });
    } catch (error) {
      failures.push({ ...feed, why: error instanceof Error ? error.message : String(error) });
    }
  }

  // Recorded but followed by no feed: an id retired from the list, or renamed upstream. The row is what keeps
  // Remove reachable - the tab is otherwise feed-driven, and such a mod would be installed yet invisible.
  const followed = new Set(MOD_FEEDS.map((feed) => feed.id));
  for (const mod of record.mods) {
    if (followed.has(mod.id)) continue;
    let manifest: ModManifest | null = null;
    try {
      manifest = parseManifest(new TextEncoder().encode(mod.manifest), { version: mod.version });
    } catch {
      // An unreadable snapshot still names the mod through the record's own fields, and defaulting the type
      // to removable is safe: uninstall re-reads the type itself, so a wrong guess costs a refused click.
    }
    offers.push({
      id: mod.id,
      name: manifest?.name ?? mod.id,
      version: mod.version,
      type: manifest?.type ?? "pluggable",
      ...(manifest?.reason !== undefined ? { reason: manifest.reason } : {}),
      availability: mod.complete ? { kind: "unfollowed" } : { kind: "retry", version: mod.version },
    });
  }
  return { offers, failures };
}
