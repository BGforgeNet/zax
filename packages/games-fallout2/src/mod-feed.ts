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
import {
  MANIFEST_NAME,
  isModVersion,
  parseManifest,
  partOptions,
  type ModManifest,
  type ModPartGroup,
  type ModType,
} from "./manifest.js";
import { installedBaseVersion, type BaseVersion } from "./base-version.js";
import { carryOver, type CarriedSelection } from "./mod-parts.js";
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
  archive?: ReleaseAsset;
  /**
   * A part's asset by part id, for a manifest that declares parts. Only the parts this release actually
   * publishes are here: a release missing one asset still offers the others, rather than nothing.
   */
  parts?: Readonly<Record<string, ReleaseAsset>>;
  /**
   * A base mod's installer for the platform ZAX is running on, and which of the two routes it is - the
   * Windows installer program, or the payload with a script inside it. Resolved here rather than at the
   * install so eligibility can say "not for this system" without downloading anything.
   */
  installer?: { route: "windows" | "other"; asset: ReleaseAsset };
}

/**
 * The groups this release can offer: options whose asset it published, and no group left empty by that.
 *
 * The drop repeats until it settles, as the settings gates do, because a part is unselectable when what it
 * `needs` is gone - offering Cassidy's voice without its head would be offering something no install could
 * ever carry out.
 */
export function offeredParts(release: ModRelease): readonly ModPartGroup[] {
  const published = new Set(Object.keys(release.parts ?? {}));
  const declared = release.manifest.parts ?? [];
  for (;;) {
    const gone = partOptions(release.manifest).filter(
      (part) => published.has(part.id) && part.needs !== undefined && !published.has(part.needs),
    );
    if (gone.length === 0) break;
    for (const part of gone) published.delete(part.id);
  }
  return declared
    .map((group) => ({ ...group, options: group.options.filter((part) => published.has(part.id)) }))
    .filter((group) => group.options.length > 0);
}

const FEED_CACHE_MS = 30 * 60 * 1000;

const slug = (text: string): string => text.replace(/[^\w.-]+/g, "-");

const feedsDirectory = (platform: Platform): string => platform.paths.join(platform.paths.cache, "feeds");

/**
 * GitHub's release feed for a repository, newest first.
 *
 * 100 is the most one request may ask for, and this asks for it rather than taking the default 30: a mod with
 * a long history is normal - the one followed feed passed thirty releases some time ago - and a page that
 * stops short does not say so, it just answers without the releases it left out. Still one request, so a
 * repository past a hundred releases has its oldest lines invisible; the newest version is on the first page
 * either way, and it is a hotfix to an older line that would go unseen.
 */
const releasesUrl = (repository: string): string => `https://api.github.com/repos/${repository}/releases?per_page=100`;

export interface ReleaseAsset {
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

/** Whether an asset is one 7-Zip opens. A payload that is not is a single file, deployed as it stands. */
export const isArchiveName = (name: string): boolean =>
  ARCHIVE_SUFFIXES.some((end) => name.toLowerCase().endsWith(end));

/**
 * The payload when the manifest does not name one: a release's sole archive-shaped asset. Two of them is an
 * ambiguity only the author can settle, so the manifest's `archive` stays in the format for that case - and
 * so does a release of loose files, where nothing distinguishes the payload from anything else published.
 */
function soleArchive(assets: readonly ReleaseAsset[]): ReleaseAsset | undefined {
  const archives = assets.filter((asset) => asset.name !== MANIFEST_NAME && isArchiveName(asset.name));
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
/** Which of a base manifest's routes this host takes, and the asset it names - or nothing for either miss. */
function installerFor(
  platform: Platform,
  manifest: ModManifest,
  assets: readonly ReleaseAsset[],
): ModRelease["installer"] {
  const route = platform.os === "windows" ? "windows" : "other";
  const declared = manifest.installer?.[route];
  if (!declared) return undefined;
  const asset = assets.find((entry) => entry.name === declared.asset);
  return asset ? { route, asset } : undefined;
}

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
    const parts: Record<string, ReleaseAsset> = {};
    for (const part of partOptions(manifest)) {
      const asset = release.assets.find((entry) => entry.name === part.archive);
      if (asset) parts[part.id] = asset;
    }
    const installer = installerFor(platform, manifest, release.assets);
    best = {
      manifest,
      manifestText: found.text,
      manifestFromAsset: found.fromAsset,
      ...(archive ? { archive } : {}),
      ...(manifest.parts ? { parts } : {}),
      ...(installer ? { installer } : {}),
    };
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
  /**
   * Recorded at one type and offered at another. The version rises, but what the install *is* changes with
   * it - a mod taking its own removability away, and later a stacking mod becoming a base one - so the offer
   * names the change instead of calling it an update. `was` is what is on disk, which is what decides
   * whether it can still be removed.
   */
  | { kind: "convert"; from: string; was: ModType }
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
  /**
   * What a base install says about itself in `ddraw.ini`, where ZAX has no record of installing it. This is
   * the common state rather than an edge: upstream's Windows route is an exe installer, so most base installs
   * were never ZAX's, and without this they are a game type with no version and no update on offer.
   */
  baseVersion?: BaseVersion | null;
}

/** Which sequence of releases a version belongs to - `2.4.34` is the 2.4 line, which never crosses to 2.3. */
const lineOf = (version: string): string | undefined => {
  const pieces = version.split(".");
  return pieces.length >= 3 ? pieces.slice(0, 2).join(".") : undefined;
};

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
  // For a parts release the payload is whatever parts resolved: one asset short is not nothing to install.
  if (manifest.type === "base") {
    // A base mod's payload is its installer, and a release that publishes one for another system is not a
    // release that named nothing - the mod is real and this machine cannot run it, which is what it says.
    if (!release.installer)
      return {
        kind: "blocked",
        why: `${manifest.name} publishes no installer for this system.`,
      };
  } else if (!release.archive && offeredParts(release).length === 0) {
    return {
      kind: "blocked",
      why: manifest.parts
        ? `The ${manifest.name} release publishes none of the files its parts name.`
        : `The ${manifest.name} release does not say which of its files is the mod.`,
    };
  }

  if (recorded) {
    // A record written before the type was kept carries none, and unknown is not a change.
    if (recorded.type !== undefined && recorded.type !== manifest.type) {
      return { kind: "convert", from: recorded.version, was: recorded.type };
    }
    return { kind: "upgrade", from: recorded.version };
  }

  // Presence always comes from the directory; a mod there without a record upgrades by installing over.
  // For a base mod the directory says so by having become what the mod makes: a hand-installed RPU is the
  // common state, and this arm is both its upgrade path and its repair - laying the release down again.
  if (manifest.becomes !== undefined && context.install.type === manifest.becomes) {
    const held = context.baseVersion;
    // What the install stamped into `ddraw.ini` stands in for the record it has not got - but only within
    // its own line. RPU's 2.3 and 2.4 ship in lockstep and never upgrade across, so a 2.4 release meeting a
    // 2.3 install is not that install's next version; it is the other line, and picking it is the user's.
    // Both sides agreeing about lines, undefined included: UPU's versions have no line at all and compare
    // straight, while a pre-split RPU install has none and the release has one - which is the whole point of
    // the pre-split trap. That install belongs to no line, so its first update is the same choice a fresh
    // install makes, and ZAX puts it to the user rather than picking a line for them.
    const sameLine = held?.line === lineOf(manifest.version);
    if (held && sameLine) {
      const newness = compareVersions(manifest.version, held.version);
      if (newness === 0) return { kind: "installed" };
      return newness > 0 ? { kind: "upgrade", from: held.version } : { kind: "downgrade", from: held.version };
    }
    return { kind: "install-over" };
  }
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

/**
 * Whether the mod is already in the install's `mods/`.
 *
 * A release that declares its `entries` is judged against those, which is the only thing that answers for a
 * payload whose filename an id cannot reach: an id carries no underscore and most of these filenames do, so
 * `cassidy_head.dat` matches no id that could be minted for it. Without a declaration the id's own convention
 * stands - `<id>` or `<id>.*`, file or folder alike - which is what every manifest written before the field
 * relied on.
 */
export async function presentInMods(
  platform: Platform,
  installPath: string,
  id: string,
  entries?: readonly string[],
): Promise<boolean> {
  const directory = platform.paths.join(installPath, MODS_DIRECTORY);
  if ((await platform.fs.stat(directory))?.kind !== "dir") return false;
  const held = await platform.fs.list(directory);
  // A declared entry may be nested - `patches/extra.dat` - and only its first piece is a name the mods folder
  // itself lists. Matching on that over-reports where the folder exists without its dat, which is the harmless
  // direction: it offers the release laid over what is there rather than beside it.
  if (entries?.length)
    return entries.some((entry) => {
      const top = (entry.split("/")[0] ?? entry).toLowerCase();
      return held.some((found) => found.name.toLowerCase() === top);
    });
  return held.some((entry) => answersToId(entry.name, id));
}

/** One mod as the interface lists it, everything plain enough to cross the process boundary. */
export interface ModOffer {
  id: string;
  name: string;
  version: string;
  type: ModType;
  /** A permanent mod's declared reason, standing where the Remove control would be. */
  reason?: string;
  /** The choice this release offers and where this install stands in it. Absent for a mod without parts. */
  parts?: ModPartsOffer;
  availability: Availability;
}

/** Everything the interface needs to draw a choice it cannot compute: the renderer reads no manifest. */
export interface ModPartsOffer extends CarriedSelection {
  /** The groups this release can deliver, in the order the manifest declares them. */
  groups: readonly ModPartGroup[];
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
      // A parts mod declares nothing at the top level, so presence is judged against every part's entries:
      // any one of them in the folder is the mod being there.
      const declared = release.manifest.entries ?? partOptions(release.manifest).flatMap((part) => part.entries ?? []);
      const present = await presentInMods(platform, install.path, feed.id, declared);
      // Read only for a base mod, and only where it could answer: a stacking mod's version is the record's.
      const baseVersion = release.manifest.type === "base" ? await installedBaseVersion(platform, install) : undefined;
      const groups = offeredParts(release);
      const carried = carryOver(release, record.mods.find((mod) => mod.id === release.manifest.id)?.parts);
      offers.push({
        id: release.manifest.id,
        name: release.manifest.name,
        version: release.manifest.version,
        type: release.manifest.type,
        ...(release.manifest.reason !== undefined ? { reason: release.manifest.reason } : {}),
        ...(groups.length > 0 ? { parts: { groups, ...carried } } : {}),
        availability: availability(release, {
          install,
          record,
          sfall,
          present,
          ...(baseVersion !== undefined ? { baseVersion } : {}),
        }),
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
