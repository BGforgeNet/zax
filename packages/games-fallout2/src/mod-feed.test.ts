import { describe, expect, it } from "vitest";
import { MemoryPlatform, type MemoryOptions } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import {
  availability,
  MOD_FEEDS,
  fetchFeed,
  fetchFeedAt,
  listModVersions,
  listingFrom,
  readModFeeds,
  readModInstallState,
  offeredParts,
  presentInMods,
  type FeedSource,
  type ModContext,
  type ModLine,
  type ModRelease,
} from "./mod-feed.js";
import { MOD_GRANTS } from "./mod-grants.js";
import { parseManifest } from "./manifest.js";
import type { InstallRecord } from "./records.js";

const REPO = "BGforgeNet/FO2tweaks";
const FEED = { repository: REPO, id: "fo2tweaks" };
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`;

/**
 * Both halves put together, which is what the backend does with them and so what these cases are about. Kept
 * here rather than shipped: nothing in the application needs the pair read back to back, since holding the
 * published half across a change of game is the point of their being apart.
 */
const wholeListing = async (
  platform: MemoryPlatform,
  install: Install,
  record: InstallRecord,
  sfall: string | null,
) => {
  const { listing, releases } = await readModFeeds(platform);
  return listingFrom(listing, await readModInstallState(platform, releases, install, record, sfall));
};

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

/** Where the repository route reads a committed manifest from, for a tag. */
const atTag = (tag: string) => `https://raw.githubusercontent.com/${REPO}/${tag}/f2mod.yml`;

/** A manifest as an author commits it: no version, no archive - the tag and the release supply both. */
const committed = (id: string, rest = "") => `spec: 1\nid: ${id}\nname: ${id}\ngame: fallout2\n${rest}`;

const feedPlatform = (options: MemoryOptions = {}) => new MemoryPlatform(options);

describe("fetchFeed", () => {
  it("takes the newest release that carries the followed id, skipping ones without a manifest", async () => {
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v15", false), release("v14.7", true)]),
        [atTag("v15")]: 404,
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
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v15", false), release("v14", false)]),
        [atTag("v15")]: 404,
        [atTag("v14")]: 404,
      },
    });
    await expect(fetchFeed(platform, FEED)).rejects.toThrow(/no release of .* ships a zax manifest yet/i);
  });

  it("takes the version from the tag and the payload from the sole archive, when the release states neither", async () => {
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v14.7", false)]),
        [atTag("v14.7")]: committed("fo2tweaks"),
      },
    });
    const found = await fetchFeed(platform, FEED);
    expect(found.manifest.version).toBe("14.7");
    expect(found.manifest.archive).toBe("fo2tweaks.zip");
    expect(found.archive?.url).toBe("https://example.test/v14.7/fo2tweaks.zip");
    expect(found.manifestFromAsset).toBe(false);
  });

  it("keeps a stated version over the tag's, the manifest being the more specific claim", async () => {
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v99", false)]),
        [atTag("v99")]: committed("fo2tweaks", 'version: "14.7"\n'),
      },
    });
    expect((await fetchFeed(platform, FEED)).manifest.version).toBe("14.7");
  });

  it("refuses a tag that names no version rather than inventing one", async () => {
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("nightly", false)]),
        [atTag("nightly")]: committed("fo2tweaks"),
      },
    });
    await expect(fetchFeed(platform, FEED)).rejects.toThrow(/states no "version"/);
  });

  it("names no payload where two archives could be it - the ambiguity only the manifest can settle", async () => {
    const other = { name: "fo2tweaks-nomusic.zip", browser_download_url: "https://example.test/v14.7/nomusic.zip" };
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v14.7", false, [other])]),
        [atTag("v14.7")]: committed("fo2tweaks"),
      },
    });
    const found = await fetchFeed(platform, FEED);
    expect(found.manifest.archive).toBeUndefined();
    expect(found.archive).toBeUndefined();
  });

  it("ignores assets that are not archives when inferring the payload", async () => {
    const sums = { name: "checksums.txt", browser_download_url: "https://example.test/v14.7/checksums.txt" };
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([release("v14.7", false, [sums])]),
        [atTag("v14.7")]: committed("fo2tweaks"),
      },
    });
    expect((await fetchFeed(platform, FEED)).manifest.archive).toBe("fo2tweaks.zip");
  });

  it("asks the repository once per tag, remembering which tags carry no manifest", async () => {
    const platform = feedPlatform({
      responses: { [RELEASES_URL]: JSON.stringify([release("v15", false)]), [atTag("v15")]: 404 },
    });
    await expect(fetchFeed(platform, FEED)).rejects.toThrow(/ships a zax manifest yet/i);
    await expect(fetchFeed(platform, FEED)).rejects.toThrow(/ships a zax manifest yet/i);
    expect(platform.fetched.filter((url) => url === atTag("v15"))).toHaveLength(1);
  });

  it("reports a repository that cannot be reached rather than reading it as a tag without a manifest", async () => {
    const platform = feedPlatform({ responses: { [RELEASES_URL]: JSON.stringify([release("v15", false)]) } });
    await expect(fetchFeed(platform, FEED)).rejects.toThrow(/No canned response/);
  });
});

describe("availability", () => {
  const install: Install = { path: "/games/fallout2", type: "fallout2" };
  const parsed = (text: string): ModRelease => ({
    manifestFromAsset: true,
    manifest: {
      id: "fo2tweaks",
      name: "FO2tweaks",
      version: "14.7",
      type: "pluggable",
      refuse: [],
      settings: [],
      dropped: [],
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

  it("does not call a type change an upgrade - what is recorded decides what the offer is", () => {
    const base = parsed("");
    const release: ModRelease = { ...base, manifest: { ...base.manifest, type: "permanent" } };
    const was = (type: "pluggable" | "permanent") => ({
      path: install.path,
      mods: [{ id: "fo2tweaks", version: "14.6", complete: true, type, files: [], manifest: "", shipped: {} }],
    });

    expect(availability(release, context({ record: was("pluggable") }))).toEqual({
      kind: "convert",
      from: "14.6",
      was: "pluggable",
    });
    // The same type on both sides is an ordinary upgrade, and so is a record too old to carry one at all.
    expect(availability(release, context({ record: was("permanent") }))).toEqual({ kind: "upgrade", from: "14.6" });
    expect(availability(release, context({ record: recorded("14.6") }))).toEqual({ kind: "upgrade", from: "14.6" });
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
    const bare: ModRelease = { manifest: parsed("").manifest, manifestText: "", manifestFromAsset: true };
    expect(availability(bare, context())).toMatchObject({ kind: "blocked" });
    expect(availability(bare, context({ record: recorded("14.7") }))).toEqual({ kind: "installed" });
  });
});

describe("the two halves of a listing, composed the way the backend composes them", () => {
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
    const listing = await wholeListing(platform, install, record, null);
    const offer = listing.offers.find((one) => one.id === "oldmod");
    expect(offer).toMatchObject({ name: "Old Mod", version: "3", type: "pluggable" });
    expect(offer?.availability).toEqual({ kind: "unfollowed" });
    expect(listing.offers.find((one) => one.id === "older")).toMatchObject({ name: "older", type: "pluggable" });
    // Every base feed gets its own row - here all failures, this network being empty. The stacking mod is
    // followed just the same and stays silent about it, which is the whole difference the row's flag makes.
    expect(listing.failures.map((failure) => failure.name)).toEqual(
      MOD_FEEDS.filter((feed) => feed.base).map((feed) => feed.name),
    );
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
    const listing = await wholeListing(platform, install, record, null);
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

  it("answers from the declared entries when the release names them, which an id cannot always reach", async () => {
    // An id may carry no underscore, and most payload filenames do - so `cassidy_head.dat` answers to no id
    // that could be minted for it, and the stem match alone reports a hand-installed copy as absent.
    const platform = new MemoryPlatform({ files: { "/game/mods/cassidy_head.dat": "" } });
    expect(await presentInMods(platform, "/game", "cassidy")).toBe(false);
    expect(await presentInMods(platform, "/game", "cassidy", ["cassidy_head.dat"])).toBe(true);
    expect(await presentInMods(platform, "/game", "cassidy", ["cassidy_voice_hq.dat"])).toBe(false);
  });

  it("matches a declared folder entry, which is what the loader loads it as", async () => {
    const platform = new MemoryPlatform({ files: { "/game/mods/InventoryFilter.dat/InvenFilter.ini": "" } });
    expect(await presentInMods(platform, "/game", "inventoryfilter", ["InventoryFilter.dat"])).toBe(true);
  });

  it("matches a nested entry by the folder it sits in, which is all the mods folder lists", async () => {
    const platform = new MemoryPlatform({ files: { "/game/mods/patches/extra.dat": "" } });
    expect(await presentInMods(platform, "/game", "patched", ["patches/extra.dat"])).toBe(true);
    expect(await presentInMods(platform, "/game", "patched", ["elsewhere/extra.dat"])).toBe(false);
  });
});

describe("a release of loose files", () => {
  it("infers no payload from them, so the manifest has to name one", async () => {
    // Cassidy publishes four `.dat` assets and no archive. Nothing distinguishes the payload from the rest,
    // so inference stays archive-only and a committed manifest that names none has no payload at all.
    const loose = {
      tag_name: "v1.0",
      assets: [
        { name: "cassidy_head.dat", browser_download_url: "https://example.test/v1.0/head.dat", digest: "sha256:aa" },
        { name: "cassidy_voice.dat", browser_download_url: "https://example.test/v1.0/voice.dat", digest: "sha256:bb" },
      ],
    };
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([loose]),
        [atTag("v1.0")]: committed("fo2tweaks"),
      },
    });
    const found = await fetchFeed(platform, FEED);
    expect(found.manifest.archive).toBeUndefined();
    expect(found.archive).toBeUndefined();
    // Which the offer reports as what it is, rather than picking one of the two.
    const where: ModContext = {
      install: { path: "/game", type: "fallout2" },
      record: { path: "/game", mods: [] },
      sfall: "4.5",
      present: false,
    };
    expect(availability(found, where)).toMatchObject({
      kind: "blocked",
      why: expect.stringContaining("which of its files"),
    });
  });

  it("takes the one the manifest names, archive-shaped or not", async () => {
    const platform = feedPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([
          {
            tag_name: "v1.0",
            assets: [
              {
                name: "cassidy_head.dat",
                browser_download_url: "https://example.test/v1.0/head.dat",
                digest: "sha256:aa",
                size: 4,
              },
            ],
          },
        ]),
        [atTag("v1.0")]: committed("fo2tweaks", "archive: cassidy_head.dat\nentries: [cassidy_head.dat]\n"),
      },
    });
    const found = await fetchFeed(platform, FEED);
    expect(found.archive?.name).toBe("cassidy_head.dat");
  });
});

describe("the grants list", () => {
  it("grants only ids a feed follows", () => {
    const followed = new Set(MOD_FEEDS.map((feed) => feed.id));
    for (const grant of MOD_GRANTS) expect([...followed]).toContain(grant.id);
    // Empty today, since the two mods known to need a grant publish no manifest and so have no id yet. This
    // is the same check against an id that would be wrong, so the one above is not passing on an empty list.
    expect(followed.has("hqmusic")).toBe(false);
  });
});

describe("a release with several payloads", () => {
  const install: Install = { path: "/games/fallout2", type: "fallout2" };

  /** Cassidy as it publishes: a manifest asset, and one `.dat` per part. */
  const CASSIDY = `spec: 1
id: cassidy
name: Cassidy Restoration
version: "1.2"
game: fallout2
parts:
  - label: Head
    pick: any
    options:
      - id: head
        label: New head
        archive: cassidy_head.dat
        entries: [cassidy_head.dat]
  - label: Voice
    pick: one
    options:
      - id: voice-joey
        label: Joey Bracken
        archive: cassidy_voice_joey.dat
        entries: [cassidy_voice_joey.dat]
        needs: head
      - id: voice-tom
        label: Tom Regan
        archive: cassidy_voice_tom.dat
        entries: [cassidy_voice_tom.dat]
        needs: head
`;

  const CASSIDY_FEED = { repository: "someone/cassidy", id: "cassidy" };
  const CASSIDY_RELEASES = "https://api.github.com/repos/someone/cassidy/releases?per_page=100";
  const asset = (name: string) => ({
    name,
    browser_download_url: `https://example.test/v1.2/${name}`,
    digest: "sha256:bb",
    size: 4,
  });
  const cassidyRelease = (names: readonly string[]) => ({
    tag_name: "v1.2",
    assets: [asset("f2mod.yml"), ...names.map(asset)],
  });
  const cassidyPlatform = (names: readonly string[]) =>
    new MemoryPlatform({
      responses: {
        [CASSIDY_RELEASES]: JSON.stringify([cassidyRelease(names)]),
        "https://example.test/v1.2/f2mod.yml": CASSIDY,
      },
    });
  const ALL = ["cassidy_head.dat", "cassidy_voice_joey.dat", "cassidy_voice_tom.dat"];

  it("resolves one asset per part, and no top-level payload", async () => {
    const found = await fetchFeed(cassidyPlatform(ALL), CASSIDY_FEED);
    expect(found.archive).toBeUndefined();
    expect(Object.keys(found.parts ?? {})).toEqual(["head", "voice-joey", "voice-tom"]);
    expect(found.parts?.["head"]).toEqual({
      name: "cassidy_head.dat",
      url: "https://example.test/v1.2/cassidy_head.dat",
      digest: "sha256:bb",
      size: 4,
    });
  });

  it("offers the parts that resolved, and not the one the release did not publish", async () => {
    const found = await fetchFeed(cassidyPlatform(["cassidy_head.dat", "cassidy_voice_joey.dat"]), CASSIDY_FEED);
    expect(offeredParts(found).map((group) => group.options.map((part) => part.id))).toEqual([
      ["head"],
      ["voice-joey"],
    ]);
    expect(
      availability(found, { install, record: { path: install.path, mods: [] }, sfall: null, present: false }),
    ).toEqual({ kind: "install" });
  });

  it("drops a part whose needs went with it, and the group it emptied", async () => {
    // The same fixpoint the settings gates take: a part offered while what it needs is not could be picked
    // and could never be installed.
    const found = await fetchFeed(cassidyPlatform(["cassidy_voice_joey.dat"]), CASSIDY_FEED);
    expect(offeredParts(found)).toEqual([]);
  });

  it("blocks a parts release publishing none of the files its parts name", async () => {
    const found = await fetchFeed(cassidyPlatform([]), CASSIDY_FEED);
    const state = availability(found, {
      install,
      record: { path: install.path, mods: [] },
      sfall: null,
      present: false,
    });
    expect(state).toMatchObject({ kind: "blocked" });
    expect((state as { why: string }).why).toMatch(/none of the files its parts name/);
  });

  it("carries the offered choice and the one already recorded to the interface", async () => {
    // Through the one followed feed, since the list of them is ZAX's own data rather than an argument: the
    // manifest is the parts one with the followed id, which is all this assertion is about.
    const manifest = CASSIDY.replace("id: cassidy", "id: fo2tweaks");
    const platform = new MemoryPlatform({
      responses: {
        [RELEASES_URL]: JSON.stringify([{ tag_name: "v1.2", assets: [asset("f2mod.yml"), ...ALL.map(asset)] }]),
        "https://example.test/v1.2/f2mod.yml": manifest,
      },
    });
    const record = {
      path: install.path,
      mods: [
        {
          id: "fo2tweaks",
          version: "1.1",
          complete: true,
          files: ["mods/cassidy_head.dat"],
          parts: ["head"],
          manifest,
          shipped: {},
        },
      ],
    };
    // The renderer never reads a manifest, so the choice has to reach it through the offer or not at all.
    const listing = await wholeListing(platform, install, record, null);
    const offer = listing.offers.find((one) => one.id === "fo2tweaks");
    expect(offer?.choices?.groups.map((group) => group.label)).toEqual(["Head", "Voice"]);
    // Carried over rather than merely reported: this is what an upgrade would install without asking.
    expect(offer?.choices).toMatchObject({ what: "parts", selection: ["head"], dropped: [], ask: false });
  });

  it("sees the mod as installed when any part of it is in the mods folder", async () => {
    const platform = new MemoryPlatform({ files: { "/game/mods/cassidy_voice_tom.dat": "x" } });
    expect(await presentInMods(platform, "/game", "cassidy")).toBe(false);
    expect(await presentInMods(platform, "/game", "cassidy", ALL)).toBe(true);
  });
});

describe("a base mod's release", () => {
  const install: Install = { path: "/games/fallout2", type: "fallout2" };
  const RPU = `spec: 1
id: fo2tweaks
name: Restoration Project, updated
version: "2.4.34"
game: fallout2
type: base
becomes: fallout2rpu
installer:
  windows: { asset: rpu.exe, silent: inno }
  other: { asset: rpu.zip, run: rpu-install.sh }
`;

  const asset = (name: string) => ({
    name,
    browser_download_url: `https://example.test/v2.4.34/${name}`,
    digest: "sha256:cc",
    size: 800,
  });
  const basePlatform = (names: readonly string[], os: "linux" | "windows" = "linux") =>
    new MemoryPlatform({
      os,
      responses: {
        [RELEASES_URL]: JSON.stringify([{ tag_name: "v2.4.34", assets: [asset("f2mod.yml"), ...names.map(asset)] }]),
        "https://example.test/v2.4.34/f2mod.yml": RPU,
      },
    });

  const context = (over: Partial<ModContext> = {}): ModContext => ({
    install,
    record: { path: install.path, mods: [] },
    sfall: null,
    present: false,
    ...over,
  });

  it("resolves the asset this platform's route names, and says which route it is", async () => {
    const found = await fetchFeed(basePlatform(["rpu.zip", "rpu.exe"]), FEED);
    expect(found.installer).toEqual({ route: "other", asset: expect.objectContaining({ name: "rpu.zip" }) });
    const onWindows = await fetchFeed(basePlatform(["rpu.zip", "rpu.exe"], "windows"), FEED);
    expect(onWindows.installer?.route).toBe("windows");
    expect(onWindows.installer?.asset.name).toBe("rpu.exe");
  });

  it("blocks where the release publishes no installer this platform can run", async () => {
    // Windows-only release, Linux host: the mod exists and this machine cannot install it, which is a
    // different thing from a release that named no payload at all.
    const found = await fetchFeed(basePlatform(["rpu.exe"]), FEED);
    const state = availability(found, context());
    expect(state).toMatchObject({ kind: "blocked" });
    expect((state as { why: string }).why).toMatch(/no installer for this system/);
  });

  it("offers a base mod on a vanilla install and refuses it on a patched one", async () => {
    const found = await fetchFeed(basePlatform(["rpu.zip"]), FEED);
    expect(availability(found, context())).toEqual({ kind: "install" });
    const patched = availability(found, context({ install: { path: install.path, type: "fallout2upu" } }));
    expect(patched).toMatchObject({ kind: "blocked" });
    expect((patched as { why: string }).why).toMatch(/Unofficial Patch Updated/);
  });

  it("offers the same release over an install already of the type it makes - repair, and the only way in", async () => {
    // The common state: a hand-installed RPU, which has no record and is no longer vanilla, so the gate that
    // protects a vanilla game would otherwise refuse the mod its own upgrade.
    const found = await fetchFeed(basePlatform(["rpu.zip"]), FEED);
    const onRpu = context({ install: { path: install.path, type: "fallout2rpu" } });
    expect(availability(found, onRpu)).toEqual({ kind: "install-over" });
  });

  it("offers an upgrade against a record of the same mod, whatever the install has become", async () => {
    const found = await fetchFeed(basePlatform(["rpu.zip"]), FEED);
    const record = {
      path: install.path,
      mods: [
        {
          id: "fo2tweaks",
          version: "2.4.33",
          complete: true,
          type: "base" as const,
          files: [],
          manifest: RPU,
          shipped: {},
        },
      ],
    };
    expect(availability(found, context({ record, install: { path: install.path, type: "fallout2rpu" } }))).toEqual({
      kind: "upgrade",
      from: "2.4.33",
    });
  });
});

describe("a base install ZAX did not perform", () => {
  const install: Install = { path: "/games/fallout2", type: "fallout2rpu" };
  const BASE = `spec: 1
id: fo2tweaks
name: Restoration Project, updated
version: "2.4.34"
game: fallout2
type: base
becomes: fallout2rpu
installer:
  other: { asset: rpu.zip, run: rpu-install.sh }
`;
  const found = (line?: ModLine): ModRelease => ({
    manifest: parseManifest(new TextEncoder().encode(BASE)),
    manifestText: BASE,
    manifestFromAsset: true,
    installer: { route: "other", asset: { name: "rpu.zip", url: "https://example.test/rpu.zip" } },
    ...(line ? { line } : {}),
  });
  const NEWER: ModLine = { prefix: "2.4." };
  const OLDER: ModLine = { prefix: "2.3.", counter: true };
  const context = (over: Partial<ModContext>): ModContext => ({
    install,
    record: { path: install.path, mods: [] },
    sfall: null,
    present: false,
    ...over,
  });

  it("reads the version it stamped, and offers the release against it", () => {
    expect(availability(found(NEWER), context({ baseVersion: { kind: "release", version: "2.4.33" } }))).toEqual({
      kind: "upgrade",
      from: "2.4.33",
    });
    expect(availability(found(NEWER), context({ baseVersion: { kind: "release", version: "2.4.34" } }))).toEqual({
      kind: "installed",
    });
    expect(availability(found(NEWER), context({ baseVersion: { kind: "release", version: "2.4.35" } }))).toEqual({
      kind: "downgrade",
      from: "2.4.35",
    });
  });

  it("refuses the other line the way it refuses any other base mod - one to an installation", () => {
    // A 2.3 install meeting the 2.4 row: 2.4 is a different mod, and this installation already carries one.
    const state = availability(found(NEWER), context({ baseVersion: { kind: "release", version: "2.3.34" } }));
    expect(state).toMatchObject({ kind: "blocked" });
    expect((state as { why: string }).why).toMatch(/installs on Fallout 2 /);
  });

  it("upgrades a pre-split install within the line its history belongs to", () => {
    // `2.3.3u30` is patch 30 of RP 2.3.3, so its next release is 2.3.32 - the counter running on, not a
    // version numbered below `2.3.3`.
    const RPU23 = BASE.replace('version: "2.4.34"', 'version: "2.3.34"');
    const release: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(RPU23)),
      manifestText: RPU23,
      manifestFromAsset: true,
      installer: { route: "other", asset: { name: "rpu.zip", url: "https://example.test/rpu.zip" } },
      line: OLDER,
    };
    expect(availability(release, context({ baseVersion: { kind: "release", version: "2.3.3u30" } }))).toEqual({
      kind: "upgrade",
      from: "2.3.3u30",
    });
  });

  it("leaves an install that states nothing to the line its history belongs to", () => {
    // Neither row can read a version, but only one of them could have written the installation: 2.4 has
    // stamped its own number since the day it existed.
    expect(availability(found(OLDER), context({ baseVersion: null }))).toEqual({ kind: "install-over" });
    expect(availability(found(NEWER), context({ baseVersion: null }))).toMatchObject({ kind: "blocked" });
  });

  it("falls back to installing over where a mod publishes one line and says nothing", () => {
    expect(availability(found(), context({ baseVersion: null }))).toEqual({ kind: "install-over" });
  });
});

describe("a base mod with no lines at all", () => {
  it("compares its versions straight, having no line for either side to be on", async () => {
    // UPU stamps `FALLOUT II 1.02.34`, whose version is a patch number and belongs to no line - so the
    // strictness that keeps RPU's 2.3 and 2.4 apart must not stop UPU upgrading at all.
    const UPU = `spec: 1
id: fo2tweaks
name: Unofficial Patch, updated
version: "35"
game: fallout2
type: base
becomes: fallout2upu
installer:
  other: { asset: upu.zip, run: upu-install.sh }
`;
    const install: Install = { path: "/games/fallout2", type: "fallout2upu" };
    const release: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(UPU)),
      manifestText: UPU,
      manifestFromAsset: true,
      installer: { route: "other", asset: { name: "upu.zip", url: "https://example.test/upu.zip" } },
    };
    const state = availability(release, {
      install,
      record: { path: install.path, mods: [] },
      sfall: null,
      present: false,
      baseVersion: { kind: "release", version: "34" },
    });
    expect(state).toEqual({ kind: "upgrade", from: "34" });
  });

  it("reports a nightly as one rather than as an install stating no version", () => {
    // A build from between releases: it stamps the commit, and 34 may well be behind it. Read as "no version"
    // the row offered 34 as an ordinary install-over, which is a silent downgrade of a newer build.
    const manifestText = `spec: 1
id: fo2tweaks
name: Unofficial Patch, updated
version: "35"
game: fallout2
type: base
becomes: fallout2upu
installer:
  other: { asset: upu.zip, run: upu-install.sh }
`;
    const at: Install = { path: "/games/fallout2", type: "fallout2upu" };
    const nightlyRelease: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(manifestText)),
      manifestText,
      manifestFromAsset: true,
      installer: { route: "other", asset: { name: "upu.zip", url: "https://example.test/upu.zip" } },
    };
    const state = availability(nightlyRelease, {
      install: at,
      record: { path: at.path, mods: [] },
      sfall: null,
      present: false,
      baseVersion: { kind: "nightly", commit: "fc706658" },
    });
    expect(state).toEqual({ kind: "nightly", commit: "fc706658" });
  });
});

describe("a base mod beside a stacking mod of a similar name", () => {
  it("does not read another mod's dat as itself being installed", async () => {
    // The gate that keeps a base mod off an already-patched game runs before this, and a `present` that came
    // from `mods/fo2tweaks.dat` would have walked straight past it.
    const BASE = `spec: 1
id: fo2tweaks
name: Restoration Project, updated
version: "2.4.34"
game: fallout2
type: base
becomes: fallout2rpu
installer:
  other: { asset: rpu.zip, run: rpu-install.sh }
`;
    const release: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(BASE)),
      manifestText: BASE,
      manifestFromAsset: true,
      installer: { route: "other", asset: { name: "rpu.zip", url: "https://example.test/rpu.zip" } },
    };
    const onPatched: Install = { path: "/games/fallout2", type: "fallout2up" };
    const state = availability(release, {
      install: onPatched,
      record: { path: onPatched.path, mods: [] },
      sfall: null,
      present: true,
    });
    expect(state).toMatchObject({ kind: "blocked" });
    expect((state as { why: string }).why).toMatch(/installs on Fallout 2 /);
  });
});

describe("a mod that creates an install", () => {
  const CREATES = `spec: 1
id: fo1in2
name: Fallout et tu
version: "1.16.3771"
game: fallout2
type: base
becomes: fo1in2
archive: Fallout1in2.zip
creates:
  directory: Fallout1in2
inputs:
  - id: fallout1
    label: Your Fallout 1 folder
    holds: master.dat
extract-dat:
  from: fallout1
  list: undat_files.txt
  into: data
`;

  const release: ModRelease = {
    manifest: parseManifest(new TextEncoder().encode(CREATES)),
    manifestText: CREATES,
    manifestFromAsset: true,
    archive: { name: "Fallout1in2.zip", url: "https://example.test/Fallout1in2.zip" },
  };

  const install: Install = { path: "/games/fallout2", type: "fallout2" };
  const where = (over: Partial<ModContext> = {}): ModContext => ({
    install,
    record: { path: install.path, mods: [] },
    sfall: null,
    present: false,
    ...over,
  });

  it("offers an install on a host of any type, since it changes nothing about the host", () => {
    expect(availability(release, where())).toEqual({ kind: "install" });
    // Where a delegated base mod is refused on a patched game, this one is not: it writes only inside the
    // directory it makes.
    expect(availability(release, where({ install: { path: install.path, type: "fallout2rpu" } }))).toEqual({
      kind: "install",
    });
  });

  it("answers from the created install's own stamp, which is what a hand-installed one has", () => {
    expect(availability(release, where({ baseVersion: { kind: "release", version: "1.16.3771" } }))).toEqual({
      kind: "installed",
    });
    expect(availability(release, where({ baseVersion: { kind: "release", version: "1.15.3735" } }))).toEqual({
      kind: "upgrade",
      from: "1.15.3735",
    });
    expect(availability(release, where({ baseVersion: { kind: "release", version: "1.17.3800" } }))).toEqual({
      kind: "downgrade",
      from: "1.17.3800",
    });
  });

  it("offers the release over a directory that is there but says nothing about itself", () => {
    expect(availability(release, where({ present: true }))).toEqual({ kind: "install-over" });
  });

  it("carries what to ask the user for, so the interface never reads a manifest", async () => {
    const platform = new MemoryPlatform({
      files: { "/games/fallout2/fallout2.exe": "" },
      responses: {
        "https://api.github.com/repos/rotators/Fo1in2/releases?per_page=100": JSON.stringify([
          {
            tag_name: "v1.16.3771",
            assets: [
              { name: "f2mod.yml", browser_download_url: "https://example.test/f2mod.yml" },
              {
                name: "Fallout1in2.zip",
                browser_download_url: "https://example.test/Fallout1in2.zip",
                digest: "sha256:aa",
                size: 10,
              },
            ],
          },
        ]),
        "https://example.test/f2mod.yml": CREATES,
      },
    });
    const found = await fetchFeed(platform, { repository: "rotators/Fo1in2", id: "fo1in2" });
    expect(found.manifest.inputs?.[0]?.label).toBe("Your Fallout 1 folder");
  });
});

describe("a created install that is no longer there", () => {
  it("offers a fresh install rather than reporting the record's version for good", () => {
    // Deleting the folder is what ZAX tells the user to do, since it will not remove one itself - so the
    // record outliving the directory is the ordinary case rather than a corrupted state.
    const CREATES = `spec: 1
id: fo1in2
name: Fallout et tu
version: "1.16.3771"
game: fallout2
type: base
becomes: fo1in2
archive: Fallout1in2.zip
creates:
  directory: Fallout1in2
`;
    const release: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(CREATES)),
      manifestText: CREATES,
      manifestFromAsset: true,
      archive: { name: "Fallout1in2.zip", url: "https://example.test/Fallout1in2.zip" },
    };
    const install: Install = { path: "/games/fallout2", type: "fallout2" };
    const record = {
      path: install.path,
      mods: [
        {
          id: "fo1in2",
          version: "1.16.3771",
          type: "base" as const,
          complete: true,
          files: [],
          manifest: CREATES,
          shipped: {},
        },
      ],
    };
    expect(availability(release, { install, record, sfall: null, present: false })).toEqual({ kind: "install" });
    // With the directory there, the record answers as it does for every other mod.
    expect(availability(release, { install, record, sfall: null, present: true })).toEqual({ kind: "installed" });
  });
});

describe("fetchFeed with a manifest ZAX carries", () => {
  const RPU_REPO = "BGforgeNet/Fallout2_Restoration_Project";
  const RPU_FEED: FeedSource = { repository: RPU_REPO, id: "rpu24", line: { prefix: "2.4." } };
  const RPU23_FEED: FeedSource = { repository: RPU_REPO, id: "rpu23", line: { prefix: "2.3.", counter: true } };
  const RPU_RELEASES = `https://api.github.com/repos/${RPU_REPO}/releases?per_page=100`;
  const rpuAtTag = (tag: string) => `https://raw.githubusercontent.com/${RPU_REPO}/${tag}/f2mod.yml`;

  /** A release as BGforge publishes it: the installer, the payload, and no manifest of any kind. */
  const rpuRelease = (tag: string, assets: object[] = []) => ({
    tag_name: tag,
    assets: [
      { name: `rpu_${tag}.exe`, browser_download_url: `https://example.test/${tag}/rpu_${tag}.exe` },
      { name: `rpu_${tag}.zip`, browser_download_url: `https://example.test/${tag}/rpu_${tag}.zip`, size: 4 },
      ...assets,
    ],
  });

  it("describes a mod that describes itself nowhere, at the version its tag names", async () => {
    const platform = feedPlatform({
      responses: { [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.4.34")]), [rpuAtTag("v2.4.34")]: 404 },
    });
    const found = await fetchFeed(platform, RPU_FEED);
    expect(found.manifest).toMatchObject({
      id: "rpu24",
      name: "Restoration Project Updated 2.4",
      version: "2.4.34",
    });
    // Not from an asset, so the payload is never expected to carry a copy of it.
    expect(found.manifestFromAsset).toBe(false);
    // This host is not Windows, so the route resolved is the script one, and it names the release's own zip.
    expect(found.installer).toEqual({
      route: "other",
      asset: { name: "rpu_v2.4.34.zip", url: "https://example.test/v2.4.34/rpu_v2.4.34.zip", size: 4 },
    });
  });

  it("gives way to a manifest committed to the repository, which is the cheaper route to adopt", async () => {
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.4.34")]),
        [rpuAtTag("v2.4.34")]: "spec: 1\nid: rpu24\nname: RPU as its author describes it\ngame: fallout2\n",
      },
    });
    const found = await fetchFeed(platform, RPU_FEED);
    expect(found.manifest.name).toBe("RPU as its author describes it");
  });

  it("asks the repository once per release and remembers the answer", async () => {
    const platform = feedPlatform({
      responses: { [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.4.34")]), [rpuAtTag("v2.4.34")]: 404 },
    });
    await fetchFeed(platform, RPU_FEED);
    const asked = platform.fetched.filter((url) => url === rpuAtTag("v2.4.34")).length;
    // The listing is cached too, so the second call reaches neither - what matters is that the 404 is not
    // paid again for a tag already answered.
    await fetchFeed(platform, RPU_FEED);
    expect(asked).toBe(1);
    expect(platform.fetched.filter((url) => url === rpuAtTag("v2.4.34"))).toHaveLength(1);
  });

  it("gives way to a manifest the release publishes as an asset", async () => {
    const asset = { name: "f2mod.yml", browser_download_url: "https://example.test/v2.4.34/f2mod.yml" };
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.4.34", [asset])]),
        "https://example.test/v2.4.34/f2mod.yml":
          "spec: 1\nid: rpu24\nname: RPU as its author describes it\ngame: fallout2\narchive: rpu.zip\n",
      },
    });
    const found = await fetchFeed(platform, RPU_FEED);
    expect(found.manifest.name).toBe("RPU as its author describes it");
    expect(found.manifestFromAsset).toBe(true);
  });

  it("passes over a release whose tag names no version, rather than describing it", async () => {
    // A vendored document states no version, so such a release could name none either. It is not a candidate
    // and is never asked about, which leaves the feed saying nobody has adopted the format.
    const platform = feedPlatform({
      responses: { [RPU_RELEASES]: JSON.stringify([rpuRelease("latest")]), [rpuAtTag("latest")]: 404 },
    });
    await expect(fetchFeed(platform, RPU_FEED)).rejects.toThrow("ships a ZAX manifest yet");
    expect(platform.fetched).toEqual([RPU_RELEASES]);
  });

  it("asks only about the release that could win, rather than one per release ever published", async () => {
    // Every release of a repository ZAX describes would answer with the same document, so the winner is the
    // highest version its tags name - and the rest are not worth a request. This is the whole first-listing
    // cost: without it, following a repository costs one 404 per release in its history.
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([
          rpuRelease("v2.3.34"),
          rpuRelease("v2.4.34"),
          rpuRelease("v2.4.33"),
          rpuRelease("v2.2.30"),
        ]),
        [rpuAtTag("v2.4.34")]: 404,
      },
    });
    const found = await fetchFeed(platform, RPU_FEED);
    expect(found.manifest.version).toBe("2.4.34");
    // The three that could not win are not in the list, and none of them is canned - an unasked URL would
    // reject as an unreachable host, so asking one would fail this outright rather than merely count wrong.
    expect(platform.fetched).toEqual([RPU_RELEASES, rpuAtTag("v2.4.34")]);
  });

  it("orders a line by its counter, which ran on through RPU's change of scheme", async () => {
    // `v30` was the last of the single counter and `v2.3.32` the next release after it. Compared piece by
    // piece the old spelling would win for good - 30 reads as a major version above 2 - and the row would
    // offer a release from before the lines existed.
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.3.32"), rpuRelease("v30"), rpuRelease("v29")]),
        [rpuAtTag("v2.3.32")]: 404,
      },
    });
    const found = await fetchFeed(platform, RPU23_FEED);
    expect(found.manifest.version).toBe("2.3.32");
    expect(platform.fetched).toEqual([RPU_RELEASES, rpuAtTag("v2.3.32")]);
  });

  it("leaves the other line's releases to the other row", async () => {
    // The two interleave in one release list, newest first, and 2.4.34 is the newest of all - but it is not
    // this row's, and taking it would be the cross-line upgrade the whole split exists to prevent.
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.4.34"), rpuRelease("v2.3.34"), rpuRelease("v2.4.33")]),
        [rpuAtTag("v2.3.34")]: 404,
      },
    });
    const found = await fetchFeed(platform, RPU23_FEED);
    expect(found.manifest).toMatchObject({ id: "rpu23", version: "2.3.34" });
    expect(platform.fetched).toEqual([RPU_RELEASES, rpuAtTag("v2.3.34")]);
  });

  it("still asks about a release that publishes its own manifest, whatever its tag names", async () => {
    // The listing already carries the asset's name, so honouring an author's own document costs nothing -
    // and its version is the document's to state, which no tag can rule out in advance.
    const asset = { name: "f2mod.yml", browser_download_url: "https://example.test/old/f2mod.yml" };
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.4.34"), rpuRelease("v2.3.34", [asset])]),
        [rpuAtTag("v2.4.34")]: 404,
        "https://example.test/old/f2mod.yml":
          'spec: 1\nid: rpu24\nname: RPU as its author describes it\nversion: "2.4.99"\ngame: fallout2\n',
      },
    });
    const found = await fetchFeed(platform, RPU_FEED);
    expect(found.manifest).toMatchObject({ name: "RPU as its author describes it", version: "2.4.99" });
    expect(found.manifestFromAsset).toBe(true);
  });

  it("lists a line's versions newest first, and only that line's", async () => {
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([
          rpuRelease("v2.4.34"),
          rpuRelease("v2.3.34"),
          rpuRelease("v2.3.32"),
          rpuRelease("v30"),
          rpuRelease("latest"),
        ]),
      },
    });
    // The counter orders them, so v30 sits below 2.3.32 rather than above every release the split produced.
    expect(await listModVersions(platform, RPU23_FEED)).toEqual(["2.3.34", "2.3.32", "30"]);
    expect(await listModVersions(platform, RPU_FEED)).toEqual(["2.4.34"]);
  });

  it("fetches a version the user named rather than the one at the head of the line", async () => {
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.3.34"), rpuRelease("v30")]),
        [rpuAtTag("v30")]: 404,
      },
    });
    const found = await fetchFeedAt(platform, RPU23_FEED, "30");
    expect(found.manifest).toMatchObject({ id: "rpu23", version: "30" });
    // The document ZAX carries names the release's own asset, whichever release it is asked about.
    expect(found.installer?.asset.name).toBe("rpu_v30.zip");
  });

  it("says so rather than falling back when the version named is published nowhere", async () => {
    const platform = feedPlatform({ responses: { [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.3.34")]) } });
    await expect(fetchFeedAt(platform, RPU23_FEED, "2.3.99")).rejects.toThrow('publishes "rpu23" 2.3.99');
  });

  it("passes over a document whose own version falls outside the line", async () => {
    // The tag filter cannot judge a release that states its own version, so the document is read and then
    // measured against the line the same way - otherwise any number at all could win a row it never belonged to.
    const asset = { name: "f2mod.yml", browser_download_url: "https://example.test/odd/f2mod.yml" };
    const platform = feedPlatform({
      responses: {
        [RPU_RELEASES]: JSON.stringify([rpuRelease("v2.4.34"), rpuRelease("v2.3.34", [asset])]),
        [rpuAtTag("v2.4.34")]: 404,
        "https://example.test/odd/f2mod.yml":
          'spec: 1\nid: rpu24\nname: RPU as its author describes it\nversion: "9.9"\ngame: fallout2\n',
      },
    });
    expect((await fetchFeed(platform, RPU_FEED)).manifest.version).toBe("2.4.34");
  });
});

describe("a listing over the vendored rows", () => {
  const install: Install = { path: "/games/fallout2", type: "fallout2" };
  const listing = (repository: string) => `https://api.github.com/repos/${repository}/releases?per_page=100`;
  const bgforge = (mod: string, tag: string) => ({
    tag_name: tag,
    assets: [
      { name: `${mod}_${tag}.exe`, browser_download_url: `https://example.test/${mod}/${tag}.exe` },
      { name: `${mod}_${tag}.zip`, browser_download_url: `https://example.test/${mod}/${tag}.zip` },
    ],
  });

  it("offers every base mod on a vanilla install, each as the install it would make", async () => {
    const platform = new MemoryPlatform({
      files: { [`${install.path}/fallout2.exe`]: "" },
      responses: {
        [listing("BGforgeNet/Fallout2_Restoration_Project")]: JSON.stringify([
          bgforge("rpu", "v2.4.34"),
          bgforge("rpu", "v2.3.34"),
        ]),
        [listing("BGforgeNet/Fallout2_Unofficial_Patch")]: JSON.stringify([bgforge("upu", "v34")]),
        [listing("rotators/Fo1in2")]: JSON.stringify([
          {
            tag_name: "v1.16.3771",
            assets: [{ name: "Fallout1in2.zip", browser_download_url: "https://example.test/fo1in2/Fallout1in2.zip" }],
          },
        ]),
        [listing("BGforgeNet/FO2tweaks")]: JSON.stringify([]),
        // None of the three has committed a manifest, which is the answer ZAX's own copy stands in for.
        ["https://raw.githubusercontent.com/BGforgeNet/Fallout2_Restoration_Project/v2.4.34/f2mod.yml"]: 404,
        ["https://raw.githubusercontent.com/BGforgeNet/Fallout2_Restoration_Project/v2.3.34/f2mod.yml"]: 404,
        ["https://raw.githubusercontent.com/BGforgeNet/Fallout2_Unofficial_Patch/v34/f2mod.yml"]: 404,
        ["https://raw.githubusercontent.com/rotators/Fo1in2/v1.16.3771/f2mod.yml"]: 404,
      },
    });
    const found = await wholeListing(platform, install, { path: install.path, mods: [] }, null);
    // RPU's two lines are two rows over one repository: each takes its own line's newest release, and on a
    // vanilla install both are equally installable, which is the choice the split exists to put to the user.
    expect(found.offers.map((offer) => [offer.id, offer.version, offer.availability.kind])).toEqual([
      ["rpu23", "2.3.34", "install"],
      ["rpu24", "2.4.34", "install"],
      ["upu", "34", "install"],
      ["fo1in2", "1.16.3771", "install"],
    ]);
    // The one that creates an install says so, and it is the only one that asks the user for anything.
    expect(found.offers.map((offer) => offer.creates)).toEqual([undefined, undefined, undefined, "Fallout1in2"]);
    expect(found.offers[3]?.asks?.map((ask) => ask.id)).toEqual(["fallout1"]);
    // The mod nobody has adopted the format for is still followed and still fails, but it is a stacking mod:
    // a row saying a repository has not adopted the format is nothing the user can act on, so none is shown.
    expect(found.failures).toEqual([]);
  });
});
