import { MemoryPlatform } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import { describe, expect, it } from "vitest";
import { installEngine, installedEngines, removeEngine } from "./engine-install.js";
import { loadRecord } from "./records.js";

const INSTALL: Install = { path: "/games/one", type: "fallout2" };
const FEED = "https://api.github.com/repos/fallout2-ce/fallout2-ce/releases?per_page=1";
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

describe("installing an engine", () => {
  it("puts the declared members into the install", async () => {
    const platform = seeded();
    const outcome = await installEngine(platform, INSTALL, "fallout2-ce", NOW);
    expect(outcome.files).toEqual(["fallout2-ce", "ce.dat"]);
    expect(await platform.fs.stat("/games/one/fallout2-ce")).not.toBeNull();
    expect(await platform.fs.stat("/games/one/ce.dat")).not.toBeNull();
  });

  it("never writes the example config over the user's settings", async () => {
    const platform = seeded({ "/games/one/fallout2.cfg": "[sound]\nmusic_path1=mine\n" });
    await installEngine(platform, INSTALL, "fallout2-ce", NOW);
    expect(new TextDecoder().decode(await platform.fs.read("/games/one/fallout2.cfg"))).toContain("mine");
    expect(await platform.fs.stat("/games/one/EXAMPLE_fallout2.cfg")).toBeNull();
  });

  it("marks the program runnable", async () => {
    const platform = seeded();
    await installEngine(platform, INSTALL, "fallout2-ce", NOW);
    expect(platform.executable).toContain("/games/one/fallout2-ce");
  });

  it("records what it installed, and which release that is", async () => {
    const platform = seeded();
    await installEngine(platform, INSTALL, "fallout2-ce", NOW);
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
    const outcome = await installEngine(platform, INSTALL, "fallout2-ce", NOW);
    expect(outcome.replaced).toEqual(["ce.dat"]);
    expect(outcome.backup).not.toBeNull();
    expect(new TextDecoder().decode(await platform.fs.read(`${outcome.backup!}/ce.dat`))).toBe("older");
  });

  it("replaces nothing on a stock install, and says that too", async () => {
    const outcome = await installEngine(seeded(), INSTALL, "fallout2-ce", NOW);
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
    await expect(installEngine(cramped, INSTALL, "fallout2-ce", NOW)).rejects.toThrow(/needs/i);
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
    await expect(installEngine(platform, INSTALL, "fallout2-ce", NOW)).rejects.toThrow(/no build/i);
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
    await expect(installEngine(moved, INSTALL, "fallout2-ce", NOW)).rejects.toThrow(
      /fallout2-ce-linux-x64\/fallout2-ce/,
    );
  });

  it("leaves the record incomplete when the deployment fails part-way", async () => {
    const platform = seeded();
    const broken = { ...platform, fs: { ...platform.fs, makeExecutable: () => Promise.reject(new Error("no")) } };
    await expect(installEngine(broken, INSTALL, "fallout2-ce", NOW)).rejects.toThrow();
    const record = await loadRecord(platform, INSTALL.path);
    expect(record.engines?.[0]?.complete).toBe(false);
  });
});

describe("the cached archive on a bad preflight", () => {
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
    await expect(installEngine(platform, INSTALL, "fallout2-ce", NOW)).rejects.toThrow(/symbolic link/i);
    expect(
      await platform.fs.stat(CACHE_PATH),
      "a cache keyed on existence would fail the same way for ever",
    ).toBeNull();
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
    const outcome = await installEngine(platform, INSTALL, "fallout2-ce", NOW);

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

    const removal = await removeEngine(platform, INSTALL, "fallout2-ce");
    expect(removal.removed).toEqual(["Fallout II Community Edition.app"]);
    expect(await platform.fs.stat("/games/one/Fallout II Community Edition.app")).toBeNull();
    expect(await installedEngines(platform, INSTALL)).toEqual([]);
  });
});

describe("updating", () => {
  it("installs over what is there and rewrites the record", async () => {
    const platform = seeded();
    await installEngine(platform, INSTALL, "fallout2-ce", NOW);
    const again = await installEngine(platform, INSTALL, "fallout2-ce", NOW);
    expect(again.replaced).toEqual(["fallout2-ce", "ce.dat"]);
    expect(await installedEngines(platform, INSTALL)).toHaveLength(1);
  });
});

describe("removing", () => {
  it("deletes exactly what the record names, and forgets it", async () => {
    const platform = seeded({ "/games/one/master.dat": "the game" });
    await installEngine(platform, INSTALL, "fallout2-ce", NOW);
    const removal = await removeEngine(platform, INSTALL, "fallout2-ce");
    expect(removal.removed).toEqual(["fallout2-ce", "ce.dat"]);
    expect(await platform.fs.stat("/games/one/fallout2-ce")).toBeNull();
    expect(await platform.fs.stat("/games/one/master.dat")).not.toBeNull();
    expect(await installedEngines(platform, INSTALL)).toEqual([]);
  });

  it("refuses an engine that is not recorded here", async () => {
    await expect(removeEngine(seeded(), INSTALL, "fallout2-ce")).rejects.toThrow(/not installed/i);
  });
});
