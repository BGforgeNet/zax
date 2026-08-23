import { MemoryPlatform } from "@zax/platform/memory";
import { describe, expect, it } from "vitest";
import { engineById } from "./engines.js";
import { cachedEngine, enginePackage, engineOutdated, latestEngine } from "./engine-release.js";

const CE = engineById("fallout2-ce");
const FEED = "https://api.github.com/repos/fallout2-ce/fallout2-ce/releases?per_page=1";
const TAG = "https://api.github.com/repos/fallout2-ce/fallout2-ce/git/ref/tags/continious";
const COMMIT = "5f737d8fff969c90ddc86b0235afbce044c79b2d";

const RELEASE = JSON.stringify([
  {
    tag_name: "continious",
    published_at: "2026-08-23T09:37:22Z",
    assets: [
      {
        name: "fallout2-ce-linux-x64.tar.gz",
        size: 5877930,
        browser_download_url: "https://example.invalid/linux.tar.gz",
      },
      { name: "fallout2-ce-windows-x64.zip", size: 2611999, browser_download_url: "https://example.invalid/win.zip" },
    ],
  },
]);

const seeded = (extra: Record<string, unknown> = {}) =>
  new MemoryPlatform({
    os: "linux",
    arch: "x64",
    config: "cfg",
    cache: "cache",
    responses: { [FEED]: RELEASE, [TAG]: JSON.stringify({ object: { sha: COMMIT, type: "commit" } }) },
    ...extra,
  });

describe("finding the published release", () => {
  it("reads the newest release and the asset for this machine", async () => {
    const found = await latestEngine(seeded(), "fallout2-ce");
    expect(found.release).toBe("continious");
    expect(found.published).toBe("2026-08-23T09:37:22Z");
    expect(found.asset).toEqual({
      name: "fallout2-ce-linux-x64.tar.gz",
      url: "https://example.invalid/linux.tar.gz",
      size: 5877930,
    });
  });

  it("reads the commit the release's tag points at, which is what identifies a rolling build", async () => {
    expect((await latestEngine(seeded(), "fallout2-ce")).commit).toBe(COMMIT);
  });

  it("reports no commit rather than a tag object's own sha, which names a different thing", async () => {
    const platform = seeded({
      responses: { [FEED]: RELEASE, [TAG]: JSON.stringify({ object: { sha: COMMIT, type: "tag" } }) },
    });
    expect((await latestEngine(platform, "fallout2-ce")).commit).toBeNull();
  });

  it("still answers when the tag cannot be read at all - the commit is a description, not the release", async () => {
    const platform = seeded({ responses: { [FEED]: RELEASE } });
    const found = await latestEngine(platform, "fallout2-ce");
    expect(found.commit).toBeNull();
    expect(found.asset?.name).toBe("fallout2-ce-linux-x64.tar.gz");
  });

  it("answers with no asset where this machine has no build", async () => {
    const platform = seeded({ os: "windows", arch: "arm64" });
    const found = await latestEngine(platform, "fallout2-ce");
    expect(found.asset).toBeNull();
    // Still described, because the release is real and it is this machine that has nothing to run.
    expect(found.commit).toBe(COMMIT);
  });

  it("says so when the feed names no release at all", async () => {
    const platform = new MemoryPlatform({ config: "cfg", cache: "cache", responses: { [FEED]: "[]" } });
    await expect(latestEngine(platform, "fallout2-ce")).rejects.toThrow(/no release/i);
  });
});

describe("whether what is installed is behind", () => {
  const installed = {
    id: "fallout2-ce",
    release: "continious",
    published: "2026-08-01T00:00:00Z",
    complete: true,
    files: ["fallout2-ce"],
  };

  it("compares publication instants for a rolling project", () => {
    expect(
      engineOutdated(CE, installed, {
        release: "continious",
        published: "2026-08-23T09:37:22Z",
        asset: null,
        commit: null,
      }),
    ).toBe(true);
    expect(
      engineOutdated(CE, installed, {
        release: "continious",
        published: "2026-08-01T00:00:00Z",
        asset: null,
        commit: null,
      }),
    ).toBe(false);
  });

  it("says nothing rather than guessing when a recorded instant will not parse", () => {
    const broken = { ...installed, published: "some time last year" };
    expect(
      engineOutdated(CE, broken, {
        release: "continious",
        published: "2026-08-23T09:37:22Z",
        asset: null,
        commit: null,
      }),
    ).toBe(false);
  });
});

describe("the package cache", () => {
  const asset = { name: "fallout2-ce-linux-x64.tar.gz", url: "https://example.invalid/linux.tar.gz", size: 7 };
  const release = { release: "continious", published: "2026-08-23T09:37:22Z", asset, commit: null };
  // Keyed by the downloaded text rather than by path, so it answers for the archive at whatever cache path a
  // test's release lands on: MemoryPlatform's `archive.list` falls back to a lookup by a file's own content.
  const opensFine = { archives: { payload: { "fallout2-ce": "binary" } } };
  const path = (published: string) =>
    `cache/packages/engines/fallout2-ce/${published.replace(/[^0-9]/g, "")}/fallout2-ce-linux-x64.tar.gz`;

  it("downloads once and answers from the cache after that", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" }, ...opensFine });
    const first = await enginePackage(platform, CE, release, asset);
    const second = await enginePackage(platform, CE, release, asset);
    expect(second).toBe(first);
    expect(platform.downloaded).toHaveLength(1);
  });

  it("keeps one release's archive apart from another's", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" }, ...opensFine });
    const august = await enginePackage(platform, CE, release, asset);
    const july = await enginePackage(platform, CE, { ...release, published: "2026-07-01T00:00:00Z" }, asset);
    expect(july).not.toBe(august);
  });

  it("fetches again when what is cached is not the size the release declares", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" }, ...opensFine });
    await enginePackage(platform, CE, release, { ...asset, size: 999 });
    await enginePackage(platform, CE, release, { ...asset, size: 999 });
    expect(platform.downloaded).toHaveLength(2);
  });

  it("fetches again when the release declares no size to check the cache against", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" }, ...opensFine });
    await enginePackage(platform, CE, release, asset);
    await enginePackage(platform, CE, release, { ...asset, size: 0 });
    expect(platform.downloaded).toHaveLength(2);
  });

  it("removes and reports a download that will not open as an archive", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" } });
    await expect(enginePackage(platform, CE, release, asset)).rejects.toThrow(/was not an archive/i);
    expect(platform.fileAt(path(release.published)), "a bad answer must not be handed out again").toBeUndefined();
  });
});

describe("the copy the machine already holds", () => {
  const ASSET = "fallout2-ce-linux-x64.tar.gz";
  const opensFine = { archives: { payload: { "fallout2-ce": "binary" } } };
  const directory = (published: string) => `cache/packages/engines/fallout2-ce/${published.replace(/[^0-9]/g, "")}`;

  /** A release as the cache would hold it: the archive, and the note naming what that archive is. */
  const held = async (platform: MemoryPlatform, published: string, note: string | null, tag = "continious") => {
    await platform.fs.write(`${directory(published)}/${ASSET}`, new TextEncoder().encode("payload"));
    if (note !== null) {
      await platform.fs.write(`${directory(published)}/release.json`, new TextEncoder().encode(note));
    }
    return tag;
  };

  const note = (release: string, published: string, commit: string | null = null) =>
    JSON.stringify({ release, published, commit });

  it("answers with nothing when nothing is cached", async () => {
    expect(await cachedEngine(seeded(), CE, ASSET)).toBeNull();
  });

  it("reports the tag and commit from the note, which the directory name cannot carry", async () => {
    const platform = seeded();
    await held(platform, "2026-08-23T09:37:22Z", note("v1.2", "2026-08-23T09:37:22Z", COMMIT));
    const found = await cachedEngine(platform, CE, ASSET);
    expect(found?.release).toMatchObject({ release: "v1.2", published: "2026-08-23T09:37:22Z", commit: COMMIT });
    expect(found?.archive).toBe(`${directory("2026-08-23T09:37:22Z")}/${ASSET}`);
  });

  it("names no asset, since the cache holds the file rather than a way to fetch it", async () => {
    const platform = seeded();
    await held(platform, "2026-08-23T09:37:22Z", note("continious", "2026-08-23T09:37:22Z"));
    expect((await cachedEngine(platform, CE, ASSET))?.release.asset).toBeNull();
  });

  it("takes the newest of several the cache holds", async () => {
    const platform = seeded();
    await held(platform, "2026-07-01T00:00:00Z", note("old", "2026-07-01T00:00:00Z"));
    await held(platform, "2026-08-23T09:37:22Z", note("new", "2026-08-23T09:37:22Z"));
    expect((await cachedEngine(platform, CE, ASSET))?.release.release).toBe("new");
  });

  it("passes over a release with no note rather than guessing the tag from the directory", async () => {
    const platform = seeded();
    await held(platform, "2026-08-23T09:37:22Z", null);
    expect(await cachedEngine(platform, CE, ASSET)).toBeNull();
  });

  it("passes over a note it cannot parse, which is one that was not finished", async () => {
    const platform = seeded();
    await held(platform, "2026-08-23T09:37:22Z", '{"release":"conti');
    expect(await cachedEngine(platform, CE, ASSET)).toBeNull();
  });

  it("passes over an empty archive, which is a download that stopped at the first byte", async () => {
    const platform = seeded();
    await held(platform, "2026-08-23T09:37:22Z", note("continious", "2026-08-23T09:37:22Z"));
    await platform.fs.write(`${directory("2026-08-23T09:37:22Z")}/${ASSET}`, new Uint8Array());
    expect(await cachedEngine(platform, CE, ASSET)).toBeNull();
  });

  it("writes the note beside an archive cached before this version wrote them", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" }, ...opensFine });
    const asset = { name: ASSET, url: "https://example.invalid/linux.tar.gz", size: 7 };
    const release = { release: "continious", published: "2026-08-23T09:37:22Z", asset, commit: COMMIT };
    // The archive is there at the declared size, so the download is skipped - the route an existing cache takes.
    await platform.fs.write(`${directory(release.published)}/${ASSET}`, new TextEncoder().encode("payload"));
    await enginePackage(platform, CE, release, asset);
    expect(platform.downloaded, "an archive already there is not fetched again").toHaveLength(0);
    expect(await cachedEngine(platform, CE, ASSET)).not.toBeNull();
  });

  it("writes the note beside an archive it downloads, so a later run can identify it", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" }, ...opensFine });
    const asset = { name: ASSET, url: "https://example.invalid/linux.tar.gz", size: 7 };
    const release = { release: "continious", published: "2026-08-23T09:37:22Z", asset, commit: COMMIT };
    await enginePackage(platform, CE, release, asset);
    const written = await platform.fs.read(`${directory(release.published)}/release.json`);
    expect(JSON.parse(new TextDecoder().decode(written))).toEqual({
      release: "continious",
      published: "2026-08-23T09:37:22Z",
      commit: COMMIT,
    });
  });
});
