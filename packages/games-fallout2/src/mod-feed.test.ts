import { describe, expect, it } from "vitest";
import { MemoryPlatform, type MemoryOptions } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import {
  availability,
  fetchFeed,
  listAvailableMods,
  presentInMods,
  type ModContext,
  type ModRelease,
} from "./mod-feed.js";

const REPO = "BGforgeNet/FO2tweaks";
const FEED = { repository: REPO, id: "fo2tweaks" };
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;

const manifestText = (id: string, version: string, rest = "") =>
  `spec: 1\nid: ${id}\nname: ${id}\nversion: "${version}"\ngame: fallout2\narchive: ${id}.zip\n${rest}`;

const release = (tag: string, withManifest: boolean, extraAssets: object[] = []) => ({
  tag_name: tag,
  assets: [
    ...(withManifest ? [{ name: "f2mod.yml", browser_download_url: `https://example.test/${tag}/f2mod.yml` }] : []),
    {
      name: "fo2tweaks.zip",
      browser_download_url: `https://example.test/${tag}/fo2tweaks.zip`,
      digest: "sha256:aa",
      size: 9,
    },
    ...extraAssets,
  ],
});

const feedPlatform = (options: MemoryOptions = {}) => new MemoryPlatform(options);

describe("fetchFeed", () => {
  it("takes the newest release that carries the followed id, skipping ones without a manifest", async () => {
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v15", false), release("v14.7", true)]),
        "https://example.test/v14.7/f2mod.yml": manifestText("fo2tweaks", "14.7"),
      },
    });
    const found = await fetchFeed(platform, FEED);
    expect(found.manifest.version).toBe("14.7");
    expect(found.archive).toEqual({
      name: "fo2tweaks.zip",
      url: "https://example.test/v14.7/fo2tweaks.zip",
      digest: "sha256:aa",
      size: 9,
    });
  });

  it("offers the highest version, not the newest release - a backported hotfix must not shadow the line", async () => {
    // GitHub lists releases newest-first, so a 14.8 hotfix published after 15 comes first in the feed.
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v14.8", true), release("v15", true)]),
        "https://example.test/v14.8/f2mod.yml": manifestText("fo2tweaks", "14.8"),
        "https://example.test/v15/f2mod.yml": manifestText("fo2tweaks", "15"),
      },
    });
    expect((await fetchFeed(platform, FEED)).manifest.version).toBe("15");
  });

  it("walks past a manifest carrying another id - two feeds may share one repository", async () => {
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v2.4", true), release("v2.3", true)]),
        "https://example.test/v2.4/f2mod.yml": manifestText("other-line", "2.4"),
        "https://example.test/v2.3/f2mod.yml": manifestText("fo2tweaks", "2.3"),
      },
    });
    expect((await fetchFeed(platform, FEED)).manifest.version).toBe("2.3");
  });

  it("caches the release listing, and answers from a stale cache when the network refuses", async () => {
    const responses = {
      [RELEASES_URL]: JSON.stringify([release("v14.7", true)]),
      "https://example.test/v14.7/f2mod.yml": manifestText("fo2tweaks", "14.7"),
    };
    const platform = feedPlatform({ responses });
    // Just after the memory platform's own fake clock, which stamps the cache file's modification time.
    const clock = new Date(1_700_000_100_000);
    await fetchFeed(platform, FEED, clock);
    await fetchFeed(platform, FEED, clock);
    // One listing fetch and one manifest fetch: the second call was answered from the cache whole.
    expect(platform.fetched).toHaveLength(2);

    // A fresh platform holding only the cache files - the network gone - still answers.
    const offline = feedPlatform({
      files: Object.fromEntries(platform.allFiles().map((path) => [path, platform.fileAt(path)!])),
    });
    const late = new Date("2026-08-13T12:00:00Z");
    expect((await fetchFeed(offline, FEED, late)).manifest.version).toBe("14.7");
  });

  it("surfaces a manifest refusal rather than reporting nothing found", async () => {
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v99", true)]),
        "https://example.test/v99/f2mod.yml": manifestText("fo2tweaks", "99").replace("spec: 1", "spec: 2"),
      },
    });
    await expect(fetchFeed(platform, FEED)).rejects.toThrow(/newer version of ZAX/);
  });

  it("says when no release ships a manifest yet, which is the state before upstream adoption", async () => {
    const platform = feedPlatform({
      responses: { [RELEASES_URL]: JSON.stringify([release("v15", false), release("v14", false)]) },
    });
    await expect(fetchFeed(platform, FEED)).rejects.toThrow(/no release of .* ships a zax manifest yet/i);
  });
});

describe("availability", () => {
  const install: Install = { path: "/games/fallout2", type: "fallout2" };
  const parsed = (text: string): ModRelease => ({
    manifest: {
      id: "fo2tweaks",
      name: "FO2tweaks",
      version: "14.7",
      type: "pluggable",
      refuse: [],
      settings: [],
      archive: "fo2tweaks.zip",
      ...(text.includes("requiresSfall") ? { requiresSfall: "4.4.5" } : {}),
    },
    manifestText: text,
    archive: { name: "fo2tweaks.zip", url: "https://example.test/fo2tweaks.zip" },
  });
  const context = (over: Partial<ModContext> = {}): ModContext => ({
    install,
    record: { path: install.path, mods: [] },
    sfall: "4.5",
    present: false,
    ...over,
  });
  const recorded = (version: string, complete = true) => ({
    path: install.path,
    mods: [{ id: "fo2tweaks", version, complete, files: [], manifest: "", shipped: {} }],
  });

  it("offers a fresh install when nothing stands in the way", () => {
    expect(availability(parsed(""), context())).toEqual({ kind: "install" });
  });

  it("reports installed, upgrade and downgrade against the record", () => {
    expect(availability(parsed(""), context({ record: recorded("14.7") }))).toEqual({ kind: "installed" });
    expect(availability(parsed(""), context({ record: recorded("14.6") }))).toEqual({ kind: "upgrade", from: "14.6" });
    expect(availability(parsed(""), context({ record: recorded("15") }))).toEqual({ kind: "downgrade", from: "15" });
  });

  it("offers retry for an install that never finished, before anything else", () => {
    expect(availability(parsed(""), context({ record: recorded("14.7", false) }))).toEqual({
      kind: "retry",
      version: "14.7",
    });
  });

  it("offers install-over for a mod present without a record - the hand-installed case", () => {
    expect(availability(parsed(""), context({ present: true }))).toEqual({ kind: "install-over" });
  });

  it("blocks on an sfall requirement the install does not meet, naming the updater as the answer", () => {
    const release = parsed("requiresSfall");
    const blocked = availability(release, context({ sfall: "4.1" }));
    expect(blocked).toMatchObject({ kind: "blocked" });
    expect((blocked as { why: string }).why).toContain("sfall 4.4.5 or newer");
    expect((blocked as { why: string }).why).toContain("4.1");
    expect(availability(release, context({ sfall: null }))).toMatchObject({ kind: "blocked" });
    expect(availability(release, context({ sfall: "4.4.5" }))).toEqual({ kind: "install" });
  });

  it("blocks a first install on the wrong game type, but not an install-over", () => {
    const narrowed: ModRelease = { ...parsed(""), manifest: { ...parsed("").manifest, installOn: ["fallout2rpu"] } };
    const blocked = availability(narrowed, context());
    expect(blocked).toMatchObject({ kind: "blocked" });
    expect((blocked as { why: string }).why).toMatch(/Restoration Project/i);
    expect(availability(narrowed, context({ present: true }))).toEqual({ kind: "install-over" });
  });

  it("blocks every offer to download when the release never names its payload", () => {
    const bare: ModRelease = { manifest: parsed("").manifest, manifestText: "" };
    expect(availability(bare, context())).toMatchObject({ kind: "blocked" });
    expect(availability(bare, context({ record: recorded("14.7") }))).toEqual({ kind: "installed" });
  });
});

describe("listAvailableMods", () => {
  const install: Install = { path: "/games/fallout2", type: "fallout2" };

  it("lists a recorded mod no feed follows, so Remove stays reachable after an id is retired", async () => {
    const platform = new MemoryPlatform();
    const record = {
      path: install.path,
      mods: [
        {
          id: "oldmod",
          version: "3",
          complete: true,
          files: ["mods/oldmod.dat"],
          manifest: 'spec: 1\nid: oldmod\nname: Old Mod\nversion: "3"\ngame: fallout2\n',
          shipped: {},
        },
        {
          // A snapshot this version cannot read still names the mod through the record's own fields.
          id: "older",
          version: "1",
          complete: true,
          files: ["mods/older.dat"],
          manifest: "nonsense: [",
          shipped: {},
        },
      ],
    };
    const listing = await listAvailableMods(platform, install, record, null);
    const offer = listing.offers.find((one) => one.id === "oldmod");
    expect(offer).toMatchObject({ name: "Old Mod", version: "3", type: "pluggable" });
    expect(offer?.availability).toEqual({ kind: "unfollowed" });
    expect(listing.offers.find((one) => one.id === "older")).toMatchObject({ name: "older", type: "pluggable" });
    // The followed feed still gets its own row - here a failure, this network being empty.
    expect(listing.failures.map((failure) => failure.id)).toEqual(["fo2tweaks"]);
  });

  it("offers retry, not removal, for a stranded install that never finished", async () => {
    const platform = new MemoryPlatform();
    const record = {
      path: install.path,
      mods: [
        {
          id: "oldmod",
          version: "3",
          complete: false,
          files: ["mods/oldmod.dat"],
          manifest: 'spec: 1\nid: oldmod\nname: Old Mod\nversion: "3"\ngame: fallout2\n',
          shipped: {},
        },
      ],
    };
    const listing = await listAvailableMods(platform, install, record, null);
    expect(listing.offers.find((one) => one.id === "oldmod")?.availability).toEqual({
      kind: "retry",
      version: "3",
    });
  });
});

describe("presentInMods", () => {
  it("answers from the directory, matching the id as a name or a stem", async () => {
    const platform = new MemoryPlatform({ files: { "/game/mods/FO2tweaks.dat": "" } });
    expect(await presentInMods(platform, "/game", "fo2tweaks")).toBe(true);
    expect(await presentInMods(platform, "/game", "ecco")).toBe(false);
    expect(await presentInMods(platform, "/elsewhere", "fo2tweaks")).toBe(false);
  });
});
