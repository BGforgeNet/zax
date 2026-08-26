import { MemoryPlatform } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import type { Platform } from "@zax/platform";
import { describe, expect, it } from "vitest";
import { installCachedEngine, installedEngines, pinEngine } from "./engine-install.js";
import { fetchEngineBuild } from "./engine-release.js";
import { loadRecord } from "./records.js";

const INSTALL: Install = { path: "/games/one", type: "fallout2" };
const FEED = "https://api.github.com/repos/fallout2-ce/fallout2-ce/releases?per_page=30";
const URL = "https://example.invalid/linux.tar.gz";
const NOW = new Date("2026-08-23T10:45:00Z");

const RELEASE = JSON.stringify([
  {
    tag_name: "continious",
    published_at: "2026-08-23T09:37:22Z",
    assets: [{ name: "fallout2-ce-linux-x64.tar.gz", size: 7, browser_download_url: URL }],
  },
]);

/**
 * The archive as the release ships it, example config included - what proves it is not deployed. Keyed by the
 * archive's text rather than its path, since the cache names it after the release.
 */
const INSIDE = {
  "fallout2-ce-linux-x64/fallout2-ce": "binary",
  "fallout2-ce-linux-x64/ce.dat": "data",
  "fallout2-ce-linux-x64/EXAMPLE_fallout2.cfg": "[sound]\n",
};

const seeded = (files: Record<string, string> = {}) =>
  new MemoryPlatform({
    os: "linux",
    arch: "x64",
    config: "cfg",
    cache: "cache",
    responses: { [FEED]: RELEASE },
    downloads: { [URL]: "payload" },
    archives: { payload: INSIDE },
    files: { "/games/one/fallout2.exe": "", ...files },
  });

/**
 * What fetching a build and then running it does, in the two steps the application takes: the release into the
 * machine's cache, then the cache into this folder. Every deployment test drives both rather than a stand-in.
 */
const fetchAndDeploy = (platform: Platform, install: Install, now: Date = NOW) =>
  fetchEngineBuild(platform, "fallout2-ce", null).then(() =>
    installCachedEngine(platform, install, "fallout2-ce", { published: null, pin: false }, now),
  );

describe("installing an engine", () => {
  it("puts the declared members into the install", async () => {
    const platform = seeded();
    const outcome = await fetchAndDeploy(platform, INSTALL, NOW);
    expect(outcome.files).toEqual(["fallout2-ce", "ce.dat"]);
    expect(await platform.fs.stat("/games/one/fallout2-ce")).not.toBeNull();
    expect(await platform.fs.stat("/games/one/ce.dat")).not.toBeNull();
  });

  it("never writes the example config over the user's settings", async () => {
    const platform = seeded({ "/games/one/fallout2.cfg": "[sound]\nmusic_path1=mine\n" });
    await fetchAndDeploy(platform, INSTALL, NOW);
    expect(new TextDecoder().decode(await platform.fs.read("/games/one/fallout2.cfg"))).toContain("mine");
    expect(await platform.fs.stat("/games/one/EXAMPLE_fallout2.cfg")).toBeNull();
  });

  it("marks the program runnable", async () => {
    const platform = seeded();
    await fetchAndDeploy(platform, INSTALL, NOW);
    expect(platform.executable).toContain("/games/one/fallout2-ce");
  });

  it("records what it installed, and which release that is", async () => {
    const platform = seeded();
    await fetchAndDeploy(platform, INSTALL, NOW);
    expect(await installedEngines(platform, INSTALL)).toEqual([
      {
        id: "fallout2-ce",
        release: "continious",
        published: "2026-08-23T09:37:22Z",
        complete: true,
        files: ["fallout2-ce", "ce.dat"],
      },
    ]);
  });

  it("backs up what it replaces, and says where", async () => {
    const platform = seeded({ "/games/one/ce.dat": "older" });
    const outcome = await fetchAndDeploy(platform, INSTALL, NOW);
    expect(outcome.replaced).toEqual(["ce.dat"]);
    expect(outcome.backup).not.toBeNull();
    expect(new TextDecoder().decode(await platform.fs.read(`${outcome.backup!}/ce.dat`))).toBe("older");
  });

  it("replaces nothing on a stock install, and says that too", async () => {
    const outcome = await fetchAndDeploy(seeded(), INSTALL);
    expect(outcome.replaced).toEqual([]);
    expect(outcome.backup).toBeNull();
  });

  it("refuses before unpacking when the drive has not the room", async () => {
    const cramped = new MemoryPlatform({
      os: "linux",
      arch: "x64",
      config: "cfg",
      cache: "cache",
      responses: { [FEED]: RELEASE },
      downloads: { [URL]: "payload" },
      archives: { payload: INSIDE },
      files: { "/games/one/fallout2.exe": "" },
      freeSpace: 1,
    });
    await expect(fetchAndDeploy(cramped, INSTALL, NOW)).rejects.toThrow(/needs/i);
    expect(await cramped.fs.stat("/games/one/fallout2-ce")).toBeNull();
  });

  it("refuses where the machine has no build, without touching the install", async () => {
    const platform = new MemoryPlatform({
      os: "windows",
      arch: "arm64",
      config: "cfg",
      cache: "cache",
      responses: { [FEED]: RELEASE },
      files: { "/games/one/fallout2.exe": "" },
    });
    await expect(fetchAndDeploy(platform, INSTALL, NOW)).rejects.toThrow(/no build/i);
    expect(platform.downloaded).toEqual([]);
  });

  it("says which member is missing when the release layout has changed", async () => {
    // The release still downloads; it just no longer carries what the catalog names.
    const moved = new MemoryPlatform({
      os: "linux",
      arch: "x64",
      config: "cfg",
      cache: "cache",
      responses: { [FEED]: RELEASE },
      downloads: { [URL]: "payload" },
      archives: { payload: { "somewhere-else/fallout2-ce": "binary" } },
      files: { "/games/one/fallout2.exe": "" },
    });
    await expect(fetchAndDeploy(moved, INSTALL, NOW)).rejects.toThrow(/fallout2-ce-linux-x64\/fallout2-ce/);
  });

  it("deploys nothing when the archive is missing the second of two declared members", async () => {
    const platform = new MemoryPlatform({
      os: "linux",
      arch: "x64",
      config: "cfg",
      cache: "cache",
      responses: { [FEED]: RELEASE },
      downloads: { [URL]: "payload" },
      archives: { payload: { "fallout2-ce-linux-x64/fallout2-ce": "binary" } },
      files: { "/games/one/fallout2.exe": "" },
    });
    await expect(fetchAndDeploy(platform, INSTALL, NOW)).rejects.toThrow(/fallout2-ce-linux-x64\/ce\.dat/);
    expect(await platform.fs.stat("/games/one/fallout2-ce"), "the first member must not land either").toBeNull();
  });

  it("leaves the record incomplete when the deployment fails part-way", async () => {
    const platform = seeded();
    const broken = { ...platform, fs: { ...platform.fs, makeExecutable: () => Promise.reject(new Error("no")) } };
    await expect(fetchAndDeploy(broken, INSTALL, NOW)).rejects.toThrow();
    const record = await loadRecord(platform, INSTALL.path);
    expect(record.engines?.[0]?.complete).toBe(false);
  });
});

describe("discarding a bad cached archive", () => {
  // Matches the derivation `enginePackage` uses: `packages/engines/<id>/<published, digits only>/<asset name>`,
  // the same path `engine-release.test.ts` computes to assert on the cache.
  const CACHE_PATH = "cache/packages/engines/fallout2-ce/20260823093722/fallout2-ce-linux-x64.tar.gz";

  it("discards a cached archive that fails preflight, and still reports the failure", async () => {
    const platform = new MemoryPlatform({
      os: "linux",
      arch: "x64",
      config: "cfg",
      cache: "cache",
      responses: { [FEED]: RELEASE },
      downloads: { [URL]: "payload" },
      archives: { payload: INSIDE },
      files: { "/games/one/fallout2.exe": "" },
      listings: { [CACHE_PATH]: [{ name: "fallout2-ce-linux-x64/fallout2-ce", kind: "link", size: 1 }] },
    });
    await expect(fetchAndDeploy(platform, INSTALL, NOW)).rejects.toThrow(/symbolic link/i);
    expect(
      await platform.fs.stat(CACHE_PATH),
      "a cache keyed on existence would fail the same way for ever",
    ).toBeNull();
  });

  it("discards a cached archive that fails to extract, not only one that fails preflight", async () => {
    const platform = seeded();
    // Preflight reads the same canned listing either way; only extraction is made to fail here.
    const broken = {
      ...platform,
      archive: {
        ...platform.archive,
        extract: () => Promise.reject(new Error("disk error")),
      },
    };
    await expect(fetchAndDeploy(broken, INSTALL, NOW)).rejects.toThrow(/disk error/);
    expect(await platform.fs.stat(CACHE_PATH)).toBeNull();
  });
});

describe("installing on macOS", () => {
  // The only build whose deployed member is a directory - the disk image carries an application bundle, put
  // into the install whole rather than as individual files.
  const MAC_URL = "https://example.invalid/mac.dmg";
  const MAC_RELEASE = JSON.stringify([
    {
      tag_name: "continious",
      published_at: "2026-08-23T09:37:22Z",
      assets: [{ name: "Fallout.II.Community.Edition.dmg", size: 7, browser_download_url: MAC_URL }],
    },
  ]);
  const BUNDLE = "Fallout II Community Edition/Fallout II Community Edition.app";
  const INSIDE_MAC = {
    [`${BUNDLE}/Contents/MacOS/fallout2-ce`]: "binary",
    [`${BUNDLE}/Contents/Resources/ce.dat`]: "data",
  };

  const seededMac = () =>
    new MemoryPlatform({
      os: "macos",
      arch: "arm64",
      config: "cfg",
      cache: "cache",
      responses: { [FEED]: MAC_RELEASE },
      downloads: { [MAC_URL]: "mac-payload" },
      archives: { "mac-payload": INSIDE_MAC },
      files: { "/games/one/fallout2.exe": "" },
    });

  it("installs the bundle as one directory, marks it runnable, and removes it whole", async () => {
    const platform = seededMac();
    const outcome = await fetchAndDeploy(platform, INSTALL, NOW);

    expect(outcome.files).toEqual(["Fallout II Community Edition.app"]);
    expect((await platform.fs.stat("/games/one/Fallout II Community Edition.app"))?.kind).toBe("dir");
    expect(
      await platform.fs.stat("/games/one/Fallout II Community Edition.app/Contents/MacOS/fallout2-ce"),
    ).not.toBeNull();
    expect(
      await platform.fs.stat("/games/one/Fallout II Community Edition.app/Contents/Resources/ce.dat"),
    ).not.toBeNull();
    expect(platform.executable).toContain("/games/one/Fallout II Community Edition.app/Contents/MacOS/fallout2-ce");

    expect(await installedEngines(platform, INSTALL)).toEqual([
      {
        id: "fallout2-ce",
        release: "continious",
        published: "2026-08-23T09:37:22Z",
        complete: true,
        files: ["Fallout II Community Edition.app"],
      },
    ]);
  });
});

describe("updating", () => {
  it("installs over what is there and rewrites the record", async () => {
    const platform = seeded();
    await fetchAndDeploy(platform, INSTALL, NOW);
    const again = await fetchAndDeploy(platform, INSTALL, NOW);
    expect(again.replaced).toEqual(["fallout2-ce", "ce.dat"]);
    expect(await installedEngines(platform, INSTALL)).toHaveLength(1);
  });

  it("replaces a directory member whole, rather than merging the new one over what is there", async () => {
    // Set up as if a previous install already put the bundle down with a file the new release drops.
    const MAC_URL = "https://example.invalid/mac.dmg";
    const MAC_RELEASE = JSON.stringify([
      {
        tag_name: "continious",
        published_at: "2026-08-24T09:37:22Z",
        assets: [{ name: "Fallout.II.Community.Edition.dmg", size: 7, browser_download_url: MAC_URL }],
      },
    ]);
    const bundle = "Fallout II Community Edition/Fallout II Community Edition.app";
    const platform = new MemoryPlatform({
      os: "macos",
      arch: "arm64",
      config: "cfg",
      cache: "cache",
      responses: { [FEED]: MAC_RELEASE },
      downloads: { [MAC_URL]: "mac-payload" },
      archives: { "mac-payload": { [`${bundle}/Contents/MacOS/fallout2-ce`]: "binary v2" } },
      files: {
        "/games/one/fallout2.exe": "",
        "/games/one/Fallout II Community Edition.app/Contents/MacOS/fallout2-ce": "binary v1",
        "/games/one/Fallout II Community Edition.app/Contents/Resources/stale.dat": "dropped from this release",
      },
    });

    await fetchAndDeploy(platform, INSTALL, NOW);
    expect(
      await platform.fs.stat("/games/one/Fallout II Community Edition.app/Contents/Resources/stale.dat"),
      "the release dropped this file - it must not survive merged into the new bundle",
    ).toBeNull();
  });
});

describe("installing from what the machine already holds", () => {
  /** A second folder on the same machine: the archive is cached, this install has never seen the engine. */
  const SECOND: Install = { path: "/games/two", type: "fallout2" };

  const offline = (platform: MemoryPlatform): MemoryPlatform => {
    // Any request at all is the defect this path exists to avoid, so make one fail the test rather than work.
    platform.net.fetchText = () => Promise.reject(new Error("the cached install asked the network"));
    platform.net.download = () => Promise.reject(new Error("the cached install downloaded again"));
    return platform;
  };

  it("deploys into a folder that never had it, without asking the network anything", async () => {
    const platform = seeded({ "/games/two/fallout2.exe": "" });
    await fetchAndDeploy(platform, INSTALL, NOW);

    const outcome = await installCachedEngine(
      offline(platform),
      SECOND,
      "fallout2-ce",
      { published: null, pin: false },
      NOW,
    );
    expect(outcome.files).toEqual(["fallout2-ce", "ce.dat"]);
    expect(await platform.fs.stat("/games/two/fallout2-ce")).not.toBeNull();
  });

  it("records the release the cache holds, not a guess at it", async () => {
    const platform = seeded({ "/games/two/fallout2.exe": "" });
    await fetchAndDeploy(platform, INSTALL, NOW);

    await installCachedEngine(offline(platform), SECOND, "fallout2-ce", { published: null, pin: false }, NOW);
    expect(await installedEngines(platform, SECOND)).toEqual([
      expect.objectContaining({ id: "fallout2-ce", release: "continious", published: "2026-08-23T09:37:22Z" }),
    ]);
  });

  it("says so rather than half-installing when the machine holds no copy", async () => {
    const platform = seeded({ "/games/two/fallout2.exe": "" });
    await expect(
      installCachedEngine(offline(platform), SECOND, "fallout2-ce", { published: null, pin: false }, NOW),
    ).rejects.toThrow(/no copy/i);
    expect(await platform.fs.stat("/games/two/fallout2-ce")).toBeNull();
    expect(await installedEngines(platform, SECOND)).toEqual([]);
  });

  /** A second release in the cache, written as `enginePackage` writes one - the archive plus its note. */
  const alsoCached = async (platform: MemoryPlatform, published: string) => {
    const at = `cache/packages/engines/fallout2-ce/${published.replace(/[^0-9]/g, "")}`;
    await platform.fs.write(`${at}/fallout2-ce-linux-x64.tar.gz`, new TextEncoder().encode("payload"));
    await platform.fs.write(
      `${at}/release.json`,
      new TextEncoder().encode(JSON.stringify({ release: "continious", published, commit: null })),
    );
  };

  it("deploys the build asked for rather than the newest cached", async () => {
    const platform = seeded({ "/games/two/fallout2.exe": "" });
    await fetchAndDeploy(platform, INSTALL, NOW);
    await alsoCached(platform, "2026-06-01T00:00:00Z");

    const outcome = await installCachedEngine(
      offline(platform),
      SECOND,
      "fallout2-ce",
      { published: "2026-06-01T00:00:00Z", pin: true },
      NOW,
    );
    expect(outcome.published).toBe("2026-06-01T00:00:00Z");
  });

  // Switching build is now the common path, so the backup a deployment takes is exercised on every switch
  // rather than only on an install over a copy someone placed by hand.
  it("sets the build already there aside when a different one goes in", async () => {
    const platform = seeded({
      "/games/two/fallout2.exe": "",
      "/games/two/fallout2-ce": "the build that was here",
      "/games/two/ce.dat": "its data",
    });
    await fetchAndDeploy(platform, INSTALL, NOW);

    const outcome = await installCachedEngine(
      offline(platform),
      SECOND,
      "fallout2-ce",
      { published: null, pin: false },
      NOW,
    );

    expect(outcome.replaced).toEqual(["fallout2-ce", "ce.dat"]);
    expect(outcome.backup).not.toBeNull();
    const kept = await platform.fs.read(`${outcome.backup!}/fallout2-ce`);
    expect(new TextDecoder().decode(kept)).toBe("the build that was here");
  });

  it("records the pin, so the next run stays on this build", async () => {
    const platform = seeded({ "/games/two/fallout2.exe": "" });
    await fetchAndDeploy(platform, INSTALL, NOW);

    await installCachedEngine(offline(platform), SECOND, "fallout2-ce", { published: null, pin: true }, NOW);
    expect((await installedEngines(platform, SECOND))[0]?.pinned).toBe(true);
  });

  it("leaves the pin off a deployment nobody asked for by name", async () => {
    const platform = seeded({ "/games/two/fallout2.exe": "" });
    await fetchAndDeploy(platform, INSTALL, NOW);

    await installCachedEngine(offline(platform), SECOND, "fallout2-ce", { published: null, pin: false }, NOW);
    expect((await installedEngines(platform, SECOND))[0]).not.toHaveProperty("pinned");
  });
});

describe("pinning the build already in place", () => {
  it("sets and clears the pin without touching the files", async () => {
    const platform = seeded();
    await fetchAndDeploy(platform, INSTALL, NOW);

    await pinEngine(platform, INSTALL, "fallout2-ce", true);
    expect((await installedEngines(platform, INSTALL))[0]?.pinned).toBe(true);

    await pinEngine(platform, INSTALL, "fallout2-ce", false);
    expect((await installedEngines(platform, INSTALL))[0]).not.toHaveProperty("pinned");
    expect(await platform.fs.stat("/games/one/fallout2-ce")).not.toBeNull();
  });

  it("refuses a record a later ZAX wrote rather than rewriting it", async () => {
    const platform = seeded();
    await fetchAndDeploy(platform, INSTALL, NOW);
    // Simulates the on-disk state a downgrade meets: the same trick `records.test.ts` uses for mods.
    const file = platform.allFiles().find((path) => path.includes("installed-mods"));
    if (file === undefined) throw new Error("no record was written");
    const text = new TextDecoder().decode(await platform.fs.read(file));
    await platform.fs.write(file, new TextEncoder().encode(text.replace("record: 1", "record: 2")));

    await expect(pinEngine(platform, INSTALL, "fallout2-ce", true)).rejects.toThrow(/newer version of ZAX/i);
  });

  it("says nothing about an engine this folder has never run", async () => {
    await expect(pinEngine(seeded(), INSTALL, "fallout2-ce", true)).resolves.toBeUndefined();
  });
});
