import { MemoryPlatform } from "@zax/platform/memory";
import { describe, expect, it } from "vitest";
import { engineById } from "./engines.js";
import { enginePackage, engineOutdated, latestEngine } from "./engine-release.js";

const CE = engineById("fallout2-ce");
const FEED = "https://api.github.com/repos/fallout2-ce/fallout2-ce/releases?per_page=1";

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
    responses: { [FEED]: RELEASE },
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

  it("answers with no asset where this machine has no build", async () => {
    const platform = seeded({ os: "windows", arch: "arm64" });
    expect((await latestEngine(platform, "fallout2-ce")).asset).toBeNull();
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
      engineOutdated(CE, installed, { release: "continious", published: "2026-08-23T09:37:22Z", asset: null }),
    ).toBe(true);
    expect(
      engineOutdated(CE, installed, { release: "continious", published: "2026-08-01T00:00:00Z", asset: null }),
    ).toBe(false);
  });

  it("says nothing rather than guessing when a recorded instant will not parse", () => {
    const broken = { ...installed, published: "some time last year" };
    expect(engineOutdated(CE, broken, { release: "continious", published: "2026-08-23T09:37:22Z", asset: null })).toBe(
      false,
    );
  });
});

describe("the package cache", () => {
  const asset = { name: "fallout2-ce-linux-x64.tar.gz", url: "https://example.invalid/linux.tar.gz", size: 7 };
  const release = { release: "continious", published: "2026-08-23T09:37:22Z", asset };

  it("downloads once and answers from the cache after that", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" } });
    const first = await enginePackage(platform, CE, release, asset);
    const second = await enginePackage(platform, CE, release, asset);
    expect(second).toBe(first);
    expect(platform.downloaded).toHaveLength(1);
  });

  it("keeps one release's archive apart from another's", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" } });
    const august = await enginePackage(platform, CE, release, asset);
    const july = await enginePackage(platform, CE, { ...release, published: "2026-07-01T00:00:00Z" }, asset);
    expect(july).not.toBe(august);
  });

  it("fetches again when what is cached is not the size the release declares", async () => {
    const platform = seeded({ downloads: { "https://example.invalid/linux.tar.gz": "payload" } });
    await enginePackage(platform, CE, release, { ...asset, size: 999 });
    await enginePackage(platform, CE, release, { ...asset, size: 999 });
    expect(platform.downloaded).toHaveLength(2);
  });
});
