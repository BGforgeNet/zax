/**
 * What an engine project has published, and the archive that release ships, kept once per machine rather than
 * once per install.
 */

import { compareVersions, packageDirectory } from "@zax/core";
import type { DownloadOptions, Platform } from "@zax/platform";
import { buildFor, engineById, type EngineDefinition } from "./engines.js";
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
 */
const releasesUrl = (repo: string): string => `https://api.github.com/repos/${repo}/releases?per_page=1`;

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

export async function latestEngine(platform: Platform, engineId: string): Promise<EngineRelease> {
  const engine = engineById(engineId);
  const body: unknown = JSON.parse(await platform.net.fetchText(releasesUrl(engine.repo)));
  const first = (Array.isArray(body) ? body[0] : undefined) as PublishedRelease | undefined;
  const release = typeof first?.tag_name === "string" ? first.tag_name : "";
  const published = typeof first?.published_at === "string" ? first.published_at : "";
  if (release === "" || published === "") throw new Error(`${engine.name} has published no release ZAX can read.`);

  const build = buildFor(engine, platform.os, platform.arch);
  if (build === null) return { release, published, asset: null };

  const declared: unknown = first?.assets;
  const assets = Array.isArray(declared) ? (declared as PublishedAsset[]) : [];
  const wanted = assets.find((asset) => asset.name === build.asset);
  if (!wanted || typeof wanted.browser_download_url !== "string") return { release, published, asset: null };
  return {
    release,
    published,
    asset: {
      name: build.asset,
      url: wanted.browser_download_url,
      size: typeof wanted.size === "number" ? wanted.size : 0,
    },
  };
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
    const strip = (tag: string) => tag.replace(/^v\.?/i, "");
    return compareVersions(strip(installed.release), strip(latest.release)) < 0;
  }
  const had = Date.parse(installed.published);
  const now = Date.parse(latest.published);
  if (Number.isNaN(had) || Number.isNaN(now)) return false;
  return now > had;
}

/** Path-safe and stable: the instant with its punctuation dropped, which sorts and collides with nothing. */
const releaseKey = (published: string): string => published.replace(/[^0-9]/g, "");

/**
 * The cached archive for a release, downloaded if this is the first time it is asked for. Under the shared
 * package directory rather than inside the install, so one download serves every install on the machine.
 *
 * A cached file whose size is not what the release declares came from an answer that was not the file - an
 * error page served with a 200, a body that stopped early - and is discarded rather than handed out for ever.
 */
export async function enginePackage(
  platform: Platform,
  engine: EngineDefinition,
  release: EngineRelease,
  asset: EngineAsset,
  options?: EngineProgress,
): Promise<string> {
  const path = platform.paths.join(
    packageDirectory(platform),
    "engines",
    engine.id,
    releaseKey(release.published),
    asset.name,
  );
  const found = await platform.fs.stat(path);
  if (found?.kind === "file" && (asset.size === 0 || found.size === asset.size)) return path;
  await platform.fs.remove(path);

  options?.onStep?.(`Downloading ${engine.name}`);
  await platform.net.download(asset.url, path, options);
  return path;
}
