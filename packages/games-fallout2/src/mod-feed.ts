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

import { compareVersions, GAME_TYPES, type GameType, type Install } from "@zax/core";
import { NetworkError, type Platform } from "@zax/platform";
import {
  MANIFEST_NAME,
  isModVersion,
  parseManifest,
  partOptions,
  type ModInput,
  type ModManifest,
  type ModPartGroup,
  type ModType,
} from "./manifest.js";
import { vendoredManifestFor } from "./mod-vendored.js";
import type { ChoiceGroup } from "./mod-choice.js";
import { installedBaseVersion, type BaseVersion } from "./base-version.js";
import { createdInstallPath, noUpgradeHere } from "./mod-created.js";
import { carryOver, type CarriedSelection } from "./mod-parts.js";
import type { InstallRecord } from "./records.js";
import { MODS_DIRECTORY, answersToId } from "./mods.js";

export interface ModFeed {
  /** `owner/name`, the repository whose releases are read. */
  repository: string;
  /** The manifest id this entry follows through that repository's releases. */
  id: string;
  /**
   * What to call the mod before any manifest has been read. A feed that could not answer has no document to
   * take a name from, and its own id is not a name; where the manifest does arrive, the author's `name` wins.
   */
  name: string;
  /**
   * Whether the mod is the installation rather than something stacked on it. Declared on the row as well as
   * in the manifest because a feed that failed has no manifest to ask: a base mod that cannot be read is
   * worth saying so, and a stacking mod whose repository has simply not adopted the format is not.
   */
  base: boolean;
  /**
   * Which of the repository's releases this entry follows, where one repository publishes more than one line.
   * RPU is the only case and needs declaring because its releases cannot say: it ran a single counter to `v30`
   * and split into `2.3.32` and `2.4.32` at 32, publishing no manifest of its own for either.
   */
  line?: ModLine;
}

/**
 * One of a repository's parallel release lines. `prefix` is what its versions start with, and `counter` marks
 * the line that the pre-split history belongs to - RPU's bare `v30` and everything below it is 2.3's past, and
 * an install that stamps no version at all is that line's to repair rather than the newer line's to take over.
 */
export interface ModLine {
  prefix: string;
  counter?: true;
}

/** Whether a version belongs to a line: its own numbering, or the counter the line inherited. */
export const heldByLine = (line: ModLine, version: string): boolean =>
  version.startsWith(line.prefix) || (line.counter === true && /^\d+$/.test(version));

/**
 * The number a version ends on - 30 for `v30`, 34 for `2.3.34`, 30 for the `2.3.3u30` an install of that era
 * stamps. RPU's counter ran through all three spellings, so it is what orders a line whatever scheme wrote it.
 */
const counterOf = (version: string): number => {
  const match = /(\d+)$/.exec(version);
  return match?.[1] === undefined ? Number.NaN : Number(match[1]);
};

/**
 * How two of one row's versions compare. A line orders by its counter, because the schemes either side of
 * RPU's split are not comparable component by component: `30` would read as a major version above `2.4.34`.
 */
export function compareInLine(line: ModLine | undefined, a: string, b: string): number {
  if (line === undefined) return compareVersions(a, b);
  const left = counterOf(a);
  const right = counterOf(b);
  if (Number.isNaN(left) || Number.isNaN(right)) return compareVersions(a, b);
  return left - right;
}

/**
 * What reading a repository takes: the releases to list and the id to follow through them. The rest of a row
 * describes the mod where no manifest arrives, which is the listing's business rather than the fetch's.
 */
export type FeedSource = Pick<ModFeed, "repository" | "id" | "line">;

/** Base mods first: what an install is comes before what is stacked on it, and that is the order it is read in. */
export const MOD_FEEDS: readonly ModFeed[] = [
  // Two entries over one repository, which is what parallel release lines are: a 2.3 install upgrades within
  // 2.3 and never crosses, so 2.4 is a different mod rather than a branch of this one.
  {
    repository: "BGforgeNet/Fallout2_Restoration_Project",
    id: "rpu23",
    name: "RPU 2.3",
    base: true,
    line: { prefix: "2.3.", counter: true },
  },
  {
    repository: "BGforgeNet/Fallout2_Restoration_Project",
    id: "rpu24",
    name: "RPU 2.4",
    base: true,
    line: { prefix: "2.4." },
  },
  { repository: "BGforgeNet/Fallout2_Unofficial_Patch", id: "upu", name: "UPU", base: true },
  { repository: "rotators/Fo1in2", id: "fo1in2", name: "ET TU", base: true },
  { repository: "BGforgeNet/FO2tweaks", id: "fo2tweaks", name: "FO2tweaks", base: false },
];

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
  /**
   * The release line this came from, carried because versions of one line compare on their own counter and an
   * install stamping another line's version is another mod rather than an older copy of this one.
   */
  line?: ModLine;
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
const FEED_REQUEST_CONCURRENCY = 6;
const FEED_RELEASE_CONCURRENCY = 6;

interface FeedRead {
  releases: Map<string, Promise<FeedRelease[]>>;
  fetchText(url: string): Promise<string>;
}

/** One cold listing may inspect dozens of tags, but it must not turn that into dozens of simultaneous requests. */
function feedRead(platform: Platform): FeedRead {
  let active = 0;
  const waiting: Array<() => void> = [];
  const enter = (): Promise<void> => {
    if (active < FEED_REQUEST_CONCURRENCY) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiting.push(() => {
        active += 1;
        resolve();
      });
    });
  };
  const leave = (): void => {
    active -= 1;
    waiting.shift()?.();
  };

  return {
    releases: new Map(),
    fetchText: async (url) => {
      await enter();
      try {
        return await platform.net.fetchText(url);
      } finally {
        leave();
      }
    },
  };
}

/** Maps in input order, stopping new work after a failure and waiting for work already started to settle. */
async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  transform: (value: T) => Promise<R>,
): Promise<R[]> {
  // oxlint-disable-next-line unicorn/no-new-array -- sized once, then filled by index out of order by the workers.
  const results = new Array<R>(values.length);
  const failures: Array<{ index: number; error: unknown }> = [];
  let next = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = next;
      if (index >= values.length) return;
      next += 1;
      try {
        results[index] = await transform(values[index]!);
      } catch (error) {
        failures.push({ index, error });
        stopped = true;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  const failure = failures.toSorted((a, b) => a.index - b.index)[0];
  if (failure) throw failure.error;
  return results;
}

const slug = (text: string): string => text.replace(/[^\w.-]+/g, "-");

const feedsDirectory = (platform: Platform): string => platform.paths.join(platform.paths.cache, "feeds");

/**
 * Where a repository's listing is cached, and where one release's manifest is - the base path, which the
 * reader completes with the suffix that says what it found. Exported because a host can seed this cache
 * instead of answering the network for it, and it must write the paths the reader reads.
 */
export function feedCachePath(platform: Platform, repository: string, tag?: string): string {
  const base = platform.paths.join(feedsDirectory(platform), slug(repository));
  return tag === undefined ? `${base}.json` : `${base}-${slug(tag)}`;
}

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
async function readRepositoryReleases(
  platform: Platform,
  repository: string,
  now: Date,
  read: FeedRead,
): Promise<FeedRelease[]> {
  const cachePath = feedCachePath(platform, repository);
  const cached = await platform.fs.stat(cachePath);
  if (cached?.kind === "file" && now.getTime() - cached.modified < FEED_CACHE_MS) {
    return readReleases(new TextDecoder().decode(await platform.fs.read(cachePath)));
  }
  let body: string;
  try {
    body = await read.fetchText(releasesUrl(repository));
  } catch (error) {
    if (error instanceof NetworkError && cached?.kind === "file") {
      return readReleases(new TextDecoder().decode(await platform.fs.read(cachePath)));
    }
    throw error;
  }
  await platform.fs.write(cachePath, new TextEncoder().encode(body));
  return readReleases(body);
}

/** Shares a repository listing between rows, including while its first request is still in flight. */
function fetchReleases(platform: Platform, repository: string, now: Date, read: FeedRead): Promise<FeedRelease[]> {
  const held = read.releases.get(repository);
  if (held) return held;
  const pending = readRepositoryReleases(platform, repository, now, read);
  read.releases.set(repository, pending);
  return pending;
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
 * repository that ships none would otherwise cost one request per release on every listing refresh. Where
 * both routes come up empty, ZAX's own copy answers for the mods that have one.
 */
async function fetchManifestText(
  platform: Platform,
  feed: FeedSource,
  release: FeedRelease,
  version: string | undefined,
  read: FeedRead,
): Promise<FetchedManifest | null> {
  const asset = release.assets.find((entry) => entry.name === MANIFEST_NAME);
  const fromAsset = asset !== undefined;
  const base = feedCachePath(platform, feed.repository, release.tag);
  const kept = `${base}.yml`;
  if ((await platform.fs.stat(kept))?.kind === "file")
    return { text: new TextDecoder().decode(await platform.fs.read(kept)), fromAsset };

  // ZAX's own copy, for a mod that describes itself nowhere. Last rather than first: wherever the author has
  // said anything, their word is the description, so adopting the format takes effect by publishing rather
  // than by ZAX noticing. A tag naming no version gets no copy, a vendored document stating none of its own.
  const carried = fromAsset || version === undefined ? undefined : vendoredManifestFor(feed.id)?.(version);
  const fallback = carried === undefined ? null : { text: carried, fromAsset: false };

  const missing = `${base}.none`;
  if (!fromAsset && (await platform.fs.stat(missing))?.kind === "file") return fallback;

  let text: string;
  try {
    text = await read.fetchText(asset ? asset.url : repositoryManifestUrl(feed.repository, release.tag));
  } catch (error) {
    // A tag with no manifest is a release that is not for ZAX, not a broken feed - every other failure is,
    // ZAX carrying a copy or not: offering from a copy while the network is down would offer an install that
    // cannot be downloaded, and would hide an author's own manifest behind ZAX's guess at the same time.
    if (!fromAsset && error instanceof NetworkError && error.status === 404) {
      await platform.fs.write(missing, new Uint8Array());
      return fallback;
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

/**
 * The releases worth asking about. Every one of them, normally: what a release says about itself is knowable
 * only by asking it. For a row ZAX carries a document for, a release that cannot win is not worth a request -
 * the carried document states no version, so such a release's version is its tag's, and only the highest of
 * those can win. A release publishing a manifest asset stays a candidate whatever its tag names, since its own
 * document decides its version and the listing already carries the asset's name.
 *
 * This is what keeps a first listing from costing one 404 per release across a repository's whole history.
 */
function worthAsking(feed: FeedSource, releases: readonly FeedRelease[]): readonly FeedRelease[] {
  // A line's releases are the only ones this entry follows, whatever else the repository publishes - and the
  // filter comes first, so the highest below is the highest of this line rather than of both.
  const line = feed.line;
  const mine =
    line === undefined
      ? releases
      : releases.filter((release) => {
          // A release stating its own id says which line it belongs to better than its tag does, and the id
          // check below is what then keeps it or drops it. Only the tag-read releases are filtered here.
          if (release.assets.some((asset) => asset.name === MANIFEST_NAME)) return true;
          const tagged = versionFromTag(release.tag);
          return tagged !== undefined && heldByLine(line, tagged);
        });
  if (vendoredManifestFor(feed.id) === undefined) return mine;
  let highest: string | undefined;
  for (const release of mine) {
    const tagged = versionFromTag(release.tag);
    if (tagged !== undefined && (highest === undefined || compareInLine(feed.line, tagged, highest) > 0)) {
      highest = tagged;
    }
  }
  return mine.filter(
    (release) =>
      release.assets.some((asset) => asset.name === MANIFEST_NAME) ||
      // Guarded rather than compared straight: with no version-shaped tag anywhere, `highest` is undefined and
      // every tag that names no version would match it.
      (highest !== undefined && versionFromTag(release.tag) === highest),
  );
}

/**
 * What a walk over a repository's releases learned besides the release it picked: whether any manifest was
 * reachable at all, and the first one that would not parse. Both go into the message when nothing wins, where
 * "this needs a newer ZAX" is truer than "nothing found".
 */
interface FeedNotes {
  sawManifest: boolean;
  firstRefusal: Error | null;
}

/**
 * One release read as this feed's mod, or null where it is not one - another id, another line, or no manifest
 * at all. Shared by the walk that picks the current release and by the fetch of a version the user named, so
 * an older release is assembled exactly as the newest one is.
 */
async function releaseFrom(
  platform: Platform,
  feed: FeedSource,
  release: FeedRelease,
  notes: FeedNotes,
  read: FeedRead,
): Promise<ModRelease | null> {
  const tagged = versionFromTag(release.tag);
  const found = await fetchManifestText(platform, feed, release, tagged, read);
  if (found === null) return null;
  notes.sawManifest = true;
  const inferred = soleArchive(release.assets);
  let manifest: ModManifest;
  try {
    manifest = parseManifest(new TextEncoder().encode(found.text), {
      ...(tagged !== undefined ? { version: tagged } : {}),
      ...(inferred !== undefined ? { archive: inferred.name } : {}),
    });
  } catch (error) {
    notes.firstRefusal ??= error instanceof Error ? error : new Error(String(error));
    return null;
  }
  if (manifest.id !== feed.id) return null;
  // A line is a stretch of the numbering, so a document is this row's only if its version falls in it - the
  // tag filter cannot answer for a release whose own document states the version.
  if (feed.line && !heldByLine(feed.line, manifest.version)) return null;
  const archive = manifest.archive ? release.assets.find((asset) => asset.name === manifest.archive) : undefined;
  const parts: Record<string, ReleaseAsset> = {};
  for (const part of partOptions(manifest)) {
    const asset = release.assets.find((entry) => entry.name === part.archive);
    if (asset) parts[part.id] = asset;
  }
  const installer = installerFor(platform, manifest, release.assets);
  return {
    manifest,
    manifestText: found.text,
    manifestFromAsset: found.fromAsset,
    ...(feed.line ? { line: feed.line } : {}),
    ...(archive ? { archive } : {}),
    ...(manifest.parts ? { parts } : {}),
    ...(installer ? { installer } : {}),
  };
}

/**
 * Every version this row's releases name, newest first. Read from the listing already cached for the current
 * release, so putting a choice in front of the user costs no request of its own. These are what the tags say:
 * a release stating its own version in a document it publishes could name another, which the fetch then finds.
 */
export async function listModVersions(
  platform: Platform,
  feed: FeedSource,
  now: Date = new Date(),
): Promise<readonly string[]> {
  const seen = new Set<string>();
  for (const release of await fetchReleases(platform, feed.repository, now, feedRead(platform))) {
    const tagged = versionFromTag(release.tag);
    if (tagged === undefined) continue;
    if (feed.line && !heldByLine(feed.line, tagged)) continue;
    seen.add(tagged);
  }
  return [...seen].sort((a, b) => compareInLine(feed.line, b, a));
}

/**
 * The release naming one particular version, for installing something other than the newest. The whole listing
 * is searched rather than the shortlist `worthAsking` keeps: that one exists to avoid asking about releases
 * which cannot win, and a version the user named has already won.
 */
export async function fetchFeedAt(
  platform: Platform,
  feed: FeedSource,
  version: string,
  now: Date = new Date(),
): Promise<ModRelease> {
  const read = feedRead(platform);
  const notes: FeedNotes = { sawManifest: false, firstRefusal: null };
  for (const release of await fetchReleases(platform, feed.repository, now, read)) {
    if (versionFromTag(release.tag) !== version) continue;
    const built = await releaseFrom(platform, feed, release, notes, read);
    if (built !== null) return built;
  }
  if (notes.firstRefusal) throw notes.firstRefusal;
  throw new Error(`No release of ${feed.repository} publishes "${feed.id}" ${version}.`);
}

async function fetchFeedUsing(platform: Platform, feed: FeedSource, now: Date, read: FeedRead): Promise<ModRelease> {
  const releases = worthAsking(feed, await fetchReleases(platform, feed.repository, now, read));
  const notes: FeedNotes = { sawManifest: false, firstRefusal: null };
  let best: ModRelease | null = null;

  const attempts = await mapConcurrent(releases, FEED_RELEASE_CONCURRENCY, async (release) => {
    const one: FeedNotes = { sawManifest: false, firstRefusal: null };
    return { built: await releaseFrom(platform, feed, release, one, read), notes: one };
  });
  for (const { built, notes: one } of attempts) {
    notes.sawManifest ||= one.sawManifest;
    notes.firstRefusal ??= one.firstRefusal;
    if (built === null) continue;
    // Strictly higher, so a version published twice keeps its newest release's assets.
    if (best !== null && compareInLine(feed.line, built.manifest.version, best.manifest.version) <= 0) continue;
    best = built;
  }

  if (best !== null) return best;
  if (notes.firstRefusal) throw notes.firstRefusal;
  throw new Error(
    notes.sawManifest
      ? `No release of ${feed.repository} carries a manifest for "${feed.id}".`
      : `No release of ${feed.repository} ships a ZAX manifest yet.`,
  );
}

export async function fetchFeed(platform: Platform, feed: FeedSource, now: Date = new Date()): Promise<ModRelease> {
  return fetchFeedUsing(platform, feed, now, feedRead(platform));
}

/** What the interface offers for one mod on one install, decided from what is already known. */
export type Availability =
  | { kind: "install" }
  /** Present without a record - hand-installed - so the offer is the latest release laid over it. */
  | { kind: "install-over" }
  /** A build from between releases, named by the commit it was built from - see `base-version.ts`. */
  | { kind: "nightly"; commit: string }
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
  /**
   * ZAX refuses this release. `from` is what the record says is installed, which several of these arms sit in
   * front of - the sfall gate answers before the version comparison, so a refused row is often an installed
   * mod. Absent where nothing is installed, or where the refusal is the install type and no version applies.
   */
  | { kind: "blocked"; why: string; from?: string };

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

/**
 * Whether a lined base mod is this installation's to offer: its own line's stamp, or - for the line the
 * pre-split history belongs to - an installation stating no version at all, which no later line ever wrote.
 */
const offeredOnLine = (line: ModLine, held: BaseVersion | null | undefined): boolean =>
  held?.kind === "release" ? heldByLine(line, held.version) : line.counter === true;

/** A refusal that carries the installed version along with it; `blockedByType` has none to carry. */
const refuse = (why: string, from: string | undefined): Availability => ({
  kind: "blocked",
  why,
  ...(from !== undefined ? { from } : {}),
});

export function availability(release: ModRelease, context: ModContext): Availability {
  const { manifest } = release;
  const held = context.record.mods.find((mod) => mod.id === manifest.id);
  // A created install the user deleted by hand is gone, whatever the record says - and deleting that folder
  // is exactly what ZAX tells them to do, since it will not remove one itself. The directory decides, and a
  // record describing a folder that is not there would otherwise report it installed for good.
  const recorded = manifest.creates && !context.present ? undefined : held;

  if (recorded && !recorded.complete) return { kind: "retry", version: recorded.version };

  // The sfall requirement is the new release's and binds upgrades too; the updater answers it either way.
  if (manifest.requiresSfall !== undefined) {
    const held = context.sfall;
    if (held === null || compareVersions(held, manifest.requiresSfall) < 0) {
      const has = held === null ? "none" : held;
      return refuse(
        `${manifest.name} needs sfall ${manifest.requiresSfall} or newer - this install has ${has}. ZAX's sfall updater can raise it first.`,
        recorded?.version,
      );
    }
  }

  if (recorded) {
    const newness = compareVersions(manifest.version, recorded.version);
    if (newness < 0) return { kind: "downgrade", from: recorded.version };
    if (newness === 0) return { kind: "installed" };
  }

  // A mod that creates an install answers from the created directory's own stamp, and it answers here -
  // before the offers below - so an install already at this version reads as installed even on a host where
  // a later step could not run.
  if (manifest.creates && context.baseVersion?.kind === "release") {
    const newness = compareVersions(manifest.version, context.baseVersion.version);
    // Straight version comparison, with no line to cross: lines are a property of RPU's release lines, and a
    // mod that creates an install publishes one sequence.
    if (newness === 0) return { kind: "installed" };
    if (newness < 0) return { kind: "downgrade", from: context.baseVersion.version };
  }

  // An install this mod made is installed once. Every arm above answers where the version on disk is this
  // release's or newer; anything else would be laying a release over a whole game, and there is no such
  // operation to offer - upstream publishes an unpack into a folder that has none and nothing else, and doing
  // it anyway would overwrite the mod's own configuration and load order with the release's defaults.
  //
  // Any of the three is that install being there: a record of it, a version stamped in it, or the directory
  // itself. `install-over` and `upgrade` are what this arm replaces, and the plan refuses the same thing again
  // where a row is reached another way.
  // Null where the directory was read and stamps no version, absent where nothing read it; neither is a
  // version, and both are that directory being there.
  const stamped = context.baseVersion ?? undefined;
  if (manifest.creates && (recorded !== undefined || stamped !== undefined || context.present))
    return refuse(
      noUpgradeHere(manifest, context.install),
      recorded?.version ?? (stamped?.kind === "release" ? stamped.version : undefined),
    );

  // Everything from here on is an offer to download, which a release that never names its payload cannot make.
  // For a parts release the payload is whatever parts resolved: one asset short is not nothing to install.
  if (manifest.creates) {
    // Its payload is an ordinary archive, so the archive check below is the one that applies - said here
    // because the installer arm is the other kind of base mod's and does not fit this one.
    if (!release.archive)
      return refuse(`The ${manifest.name} release does not say which of its files is the mod.`, recorded?.version);
  } else if (manifest.type === "base") {
    // A base mod's payload is its installer, and a release that publishes one for another system is not a
    // release that named nothing - the mod is real and this machine cannot run it, which is what it says.
    if (!release.installer)
      return refuse(`${manifest.name} publishes no installer for this system.`, recorded?.version);
  } else if (!release.archive && offeredParts(release).length === 0) {
    return refuse(
      manifest.parts
        ? `The ${manifest.name} release publishes none of the files its parts name.`
        : `The ${manifest.name} release does not say which of its files is the mod.`,
      recorded?.version,
    );
  }

  if (recorded) {
    // A record written before the type was kept carries none, and unknown is not a change.
    if (recorded.type !== undefined && recorded.type !== manifest.type) {
      return { kind: "convert", from: recorded.version, was: recorded.type };
    }
    return { kind: "upgrade", from: recorded.version };
  }

  // A mod that creates an install has nowhere to put one here, or the arm above would have refused it: what
  // is left is a first install, on a host of a type the manifest allows.
  if (manifest.creates) return blockedByType(manifest, context) ?? { kind: "install" };

  // Presence always comes from the directory. For a base mod that means the type the directory reports and
  // nothing else - a hand-installed RPU is the common state, and this arm is both its upgrade path and its
  // repair. A file in `mods/` answering to the mod's id is somebody else's dat with a similar name, and
  // reading it as "already installed" would walk past the gate that keeps a base mod off a changed game.
  if (manifest.type === "base") {
    if (context.install.type !== manifest.becomes) return blockedByType(manifest, context) ?? { kind: "install" };
    const held = context.baseVersion;
    // A nightly stamps the commit it was built from where a release stamps its number, so nothing here can
    // order it against what the feed offers - and a build from after the last release is the common case.
    // Reported as what it is rather than as an install with no version, which is what it was read as.
    if (held?.kind === "nightly") return { kind: "nightly", commit: held.commit };
    // What the install stamped into `ddraw.ini` stands in for the record it has not got. Where the mod is
    // published in parallel lines that stamp also says WHICH of them is here, and only one base mod fits an
    // installation: another line's version is that other mod already installed, refused in the same sentence
    // as any other base mod meeting an installation it does not install on.
    if (release.line && !offeredOnLine(release.line, held)) {
      return blockedByType(manifest, context) ?? { kind: "install-over" };
    }
    if (held) {
      const newness = compareInLine(release.line, manifest.version, held.version);
      if (newness === 0) return { kind: "installed" };
      return newness > 0 ? { kind: "upgrade", from: held.version } : { kind: "downgrade", from: held.version };
    }
    return { kind: "install-over" };
  }
  if (context.present) return { kind: "install-over" };

  // The game-type gate protects a first install alone - install-over and upgrades are the same mod already.
  const blocked = blockedByType(manifest, context);
  return blocked ?? { kind: "install" };
}

/** The game-type gate: what a mod says it installs on, against what this install is. */
function blockedByType(manifest: ModManifest, context: ModContext): Availability | null {
  if (manifest.installOn === undefined || manifest.installOn.includes(context.install.type)) return null;
  const wanted = manifest.installOn.map((type) => GAME_TYPES[type].name).join(" or ");
  return {
    kind: "blocked",
    why: `${manifest.name} installs on ${wanted} - this install is ${GAME_TYPES[context.install.type].name}.`,
  };
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
  /** What a base mod turns this install into, which is the thing worth knowing before installing one. */
  becomes?: GameType;
  /** The directory a creating mod makes inside this install, where it makes one. */
  creates?: string;
  /** What the user must be asked for before this can be installed, so the interface reads no manifest. */
  asks?: readonly ModInput[];
  /**
   * The choice to make before installing this release, and where this install stands in it. A stacking mod's
   * parts and a base installer's components are the same question asked of two different manifests, so the
   * interface gets one shape and draws one dialog.
   */
  choices?: ChoiceOffer;
  /**
   * Set on a row the record alone describes, where no feed follows the mod: `version` is then what is on disk
   * rather than what is offered. Both readings otherwise have the same shape, and a retry row arrives either
   * way, so nothing downstream could tell an offered version from an installed one without this.
   */
  noFeed?: true;
  availability: Availability;
}

/** Everything the interface needs to draw a choice it cannot compute: the renderer reads no manifest. */
export interface ChoiceOffer extends CarriedSelection {
  /** Which of the two is being chosen - the words the dialog uses, and nothing else, turn on this. */
  what: "parts" | "components";
  /** The groups this release can deliver, in the order the manifest declares them. */
  groups: readonly ChoiceGroup[];
}

export interface ModListing {
  offers: readonly ModOffer[];
  /**
   * Feeds that could not answer, each with why - offline, no manifest yet, needs a newer ZAX. Base mods only:
   * a stacking mod nobody can read is not news, and four such rows would bury the mods that did answer.
   */
  failures: readonly { repository: string; id: string; name: string; why: string }[];
}

/**
 * What one feed has published, with nothing of any install in it - a repository publishes one release,
 * whichever game folder is on screen. This is the half of an offer that survives a change of game.
 */
export interface PublishedMod {
  id: string;
  name: string;
  version: string;
  type: ModType;
  reason?: string;
  becomes?: GameType;
  creates?: string;
  asks?: readonly ModInput[];
  /** The choice this release offers, without an install's answer to it - `groups` and what they are. */
  choice?: { what: "parts" | "components"; groups: readonly ChoiceGroup[] };
}

/** Every feed's current release, and the feeds that could not answer. Read once, not once per install. */
export interface ModFeedListing {
  published: readonly PublishedMod[];
  failures: readonly { repository: string; id: string; name: string; why: string }[];
}

/** Where one install stands against the published mods, which is everything a change of game invalidates. */
export interface ModInstallState {
  /** By mod id, for the published mods this install could say something about. */
  standing: Readonly<Record<string, { availability: Availability; carried?: CarriedSelection }>>;
  /** Rows only this install's record knows about, complete as they are drawn - no feed describes them. */
  unfollowed: readonly ModOffer[];
}

/** The per-app half of an offer: what the release says about itself, before any folder is considered. */
function publishedFrom(release: ModRelease, components: readonly ChoiceGroup[] | undefined): PublishedMod {
  const groups = components ?? offeredParts(release);
  return {
    id: release.manifest.id,
    name: release.manifest.name,
    version: release.manifest.version,
    type: release.manifest.type,
    ...(release.manifest.reason !== undefined ? { reason: release.manifest.reason } : {}),
    ...(release.manifest.becomes !== undefined ? { becomes: release.manifest.becomes } : {}),
    ...(release.manifest.creates ? { creates: release.manifest.creates.directory } : {}),
    ...(release.manifest.inputs ? { asks: release.manifest.inputs } : {}),
    ...(groups.length > 0 ? { choice: { what: components ? "components" : "parts", groups } } : {}),
  };
}

/**
 * A base mod's components are asked for every install rather than carried over: they are the installer's own
 * list, ZAX records no selection for them, and the installer's wizard would ask too.
 *
 * Only where this host would actually run that installer. The choice exists in the Inno installer and nowhere
 * else - RPU's build moves the optional dats out of `mods/` for that route alone, and the zip every other
 * system takes ships all of them - so offering it here would be offering a choice that changes nothing.
 */
const componentsOf = (release: ModRelease): readonly ChoiceGroup[] | undefined =>
  release.installer?.route === "windows" ? release.manifest.installer?.windows?.components : undefined;

/**
 * Every feed's current release. A feed that cannot answer costs its own row, not the listing: the other mods
 * are still installable while one repository is unreachable or unadopted. The releases come back beside the
 * listing because deciding where a mod stands needs the whole release, and only this reads the feeds.
 */
export async function readModFeeds(
  platform: Platform,
  now: Date = new Date(),
): Promise<{ listing: ModFeedListing; releases: readonly ModRelease[] }> {
  type Answer = { release: ModRelease } | { error: unknown };
  const read = feedRead(platform);
  // oxlint-disable-next-line unicorn/no-new-array -- sized once, then filled by index as each feed answers.
  const answers = new Array<Answer>(MOD_FEEDS.length);
  const repositories = new Map<string, Array<{ index: number; feed: ModFeed }>>();
  for (const [index, feed] of MOD_FEEDS.entries()) {
    const held = repositories.get(feed.repository) ?? [];
    held.push({ index, feed });
    repositories.set(feed.repository, held);
  }

  // Repositories overlap, while rows from one repository stay ordered so they share both its listing and any
  // immutable tag cache entries. Answers are assembled below in catalog order, not in network completion order.
  await Promise.all(
    [...repositories.values()].map(async (feeds) => {
      for (const { index, feed } of feeds) {
        try {
          answers[index] = { release: await fetchFeedUsing(platform, feed, now, read) };
        } catch (error) {
          answers[index] = { error };
        }
      }
    }),
  );

  const published: PublishedMod[] = [];
  const releases: ModRelease[] = [];
  const failures: { repository: string; id: string; name: string; why: string }[] = [];
  for (const [index, feed] of MOD_FEEDS.entries()) {
    const answer = answers[index]!;
    if ("release" in answer) {
      const { release } = answer;
      releases.push(release);
      published.push(publishedFrom(release, componentsOf(release)));
    } else {
      // Only a base mod earns a row here: that one is the whole installation, so a user who cannot get it
      // needs to know why. A stacking mod that is unreachable or has not adopted the format offers the same
      // sentence about a repository they never asked after.
      if (!feed.base) continue;
      const { repository, id, name } = feed;
      const { error } = answer;
      failures.push({ repository, id, name, why: error instanceof Error ? error.message : String(error) });
    }
  }
  return { listing: { published, failures }, releases };
}

/**
 * Where one install stands against releases already read. Everything here reads the game folder or the
 * install's own record, which is why it is asked again for each install and the feeds above are not.
 */
export async function readModInstallState(
  platform: Platform,
  releases: readonly ModRelease[],
  install: Install,
  record: InstallRecord,
  sfall: string | null,
): Promise<ModInstallState> {
  const standing: Record<string, { availability: Availability; carried?: CarriedSelection }> = {};
  for (const release of releases) {
    // A parts mod declares nothing at the top level, so presence is judged against every part's entries:
    // any one of them in the folder is the mod being there. A mod that creates an install is not in the
    // mods folder at all: what answers for it is the directory it makes - or this installation, where that
    // is already what this one is.
    const creates = release.manifest.creates;
    const created = creates ? createdInstallPath(platform.paths, install, { ...release.manifest, creates }) : null;
    const declared = release.manifest.entries ?? partOptions(release.manifest).flatMap((part) => part.entries ?? []);
    const present =
      created === null
        ? await presentInMods(platform, install.path, release.manifest.id, declared)
        : (await platform.fs.stat(created))?.kind === "dir";
    // Read only for a base mod, and only where it could answer: a stacking mod's version is the record's.
    // A created install stamps its own copy, one directory in, which is where this reads it.
    const baseVersion =
      release.manifest.type === "base" ? await installedBaseVersion(platform, created ?? install.path) : undefined;
    const components = componentsOf(release);
    const carried: CarriedSelection = components
      ? { selection: [], dropped: [], ask: true }
      : carryOver(release, record.mods.find((mod) => mod.id === release.manifest.id)?.parts);
    standing[release.manifest.id] = {
      availability: availability(release, {
        install,
        record,
        sfall,
        present,
        ...(baseVersion !== undefined ? { baseVersion } : {}),
      }),
      carried,
    };
  }

  // Recorded but followed by no feed: an id retired from the list, or renamed upstream. The row is what keeps
  // Remove reachable - the tab is otherwise feed-driven, and such a mod would be installed yet invisible.
  //
  // Taken from the releases that actually resolved rather than from `MOD_FEEDS`, because a feed can be listed
  // and still answer with nothing - every release refused, or none carrying a manifest for the id, which is
  // where a mod that stops publishing one ends up. Keyed on the static list, such a record matched no feed's
  // release and was skipped here too, so it had no row at all.
  const followed = new Set(releases.map((release) => release.manifest.id));
  const unfollowed: ModOffer[] = [];
  for (const mod of record.mods) {
    if (followed.has(mod.id)) continue;
    let manifest: ModManifest | null = null;
    try {
      manifest = parseManifest(new TextEncoder().encode(mod.manifest), { version: mod.version });
    } catch {
      // An unreadable snapshot still names the mod through the record's own fields, and defaulting the type
      // to removable is safe: uninstall re-reads the type itself, so a wrong guess costs a refused click.
    }
    unfollowed.push({
      id: mod.id,
      name: manifest?.name ?? mod.id,
      version: mod.version,
      type: manifest?.type ?? "pluggable",
      noFeed: true,
      ...(manifest?.reason !== undefined ? { reason: manifest.reason } : {}),
      availability: mod.complete ? { kind: "unfollowed" } : { kind: "retry", version: mod.version },
    });
  }
  return { standing, unfollowed };
}

/**
 * The two halves as one listing. Pure, so the interface can hold the feeds across a change of game and redraw
 * from a fresh install state alone. A published mod the install state says nothing about is dropped rather
 * than drawn without one: it means the two were read either side of a refresh that changed what is published,
 * and a row with no standing has no status line, no button and nothing to do.
 */
export function listingFrom(feeds: ModFeedListing, state: ModInstallState): ModListing {
  const offers: ModOffer[] = [];
  for (const mod of feeds.published) {
    const standing = state.standing[mod.id];
    if (!standing) continue;
    const { choice, ...rest } = mod;
    offers.push({
      ...rest,
      ...(choice ? { choices: { ...choice, ...(standing.carried ?? { selection: [], dropped: [], ask: true }) } } : {}),
      availability: standing.availability,
    });
  }
  return { offers: [...offers, ...state.unfollowed], failures: feeds.failures };
}
