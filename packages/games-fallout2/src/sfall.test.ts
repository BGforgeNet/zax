import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { library } from "./pe-fixture.js";
import {
  installedSfallVersion,
  latestSfall,
  listSfallVersions,
  releaseUrl,
  sfallDefaults,
  sfallPackage,
  updateSfall,
} from "./sfall.js";
import type { Install } from "@zax/core";

const INSTALL: Install = { path: "/games/one", type: "fallout2" };
const FEED = "https://sourceforge.net/projects/sfall/best_release.json";

/**
 * A stand-in release archive. It begins with 7z's own magic because that is what `sfallPackage` checks for;
 * a fixture of arbitrary bytes would land on the rejection path and prove nothing about the update it is
 * named for.
 */
function archiveBytes(label: string): Uint8Array {
  const magic = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
  return new Uint8Array([...magic, ...[...label].map((c) => c.charCodeAt(0) & 0xff)]);
}

describe("reading the installed version", () => {
  it("reports nothing for an install with no sfall, which is a normal install", async () => {
    const platform = new MemoryPlatform({ files: { "/games/one/fallout2.exe": "MZ" } });
    expect(await installedSfallVersion(platform, INSTALL)).toBeNull();
  });

  it("reads the version from the install's own library", async () => {
    const platform = new MemoryPlatform({ files: { "/games/one/ddraw.dll": library({ FileVersion: "4.5" }) } });
    expect(await installedSfallVersion(platform, INSTALL)).toBe("4.5");
  });
});

describe("asking for the latest release", () => {
  /** The feed's own shape, cut to the two fields that are read. */
  const body = (filename: string) =>
    JSON.stringify({ release: { filename, url: "https://sourceforge.net/projects/sfall/files/x/download" } });

  it("takes the version from the archive's name, which is the only place it appears", async () => {
    const platform = new MemoryPlatform({ responses: { [FEED]: body("/sfall/sfall_4.5.7z") } });
    expect(await latestSfall(platform)).toEqual({
      version: "4.5",
      url: "https://sourceforge.net/projects/sfall/files/x/download",
    });
  });

  it("handles a three-part version, which earlier releases used", async () => {
    const platform = new MemoryPlatform({ responses: { [FEED]: body("/sfall/sfall_4.1.2.7z") } });
    expect((await latestSfall(platform)).version).toBe("4.1.2");
  });

  it("reports a feed that names no release rather than reporting an empty version", async () => {
    const platform = new MemoryPlatform({ responses: { [FEED]: JSON.stringify({ release: {} }) } });
    await expect(latestSfall(platform)).rejects.toThrow(/did not name a release/);
  });
});

describe("updating", () => {
  const AT = new Date(2026, 7, 5, 18, 30, 0);
  const BACKUP = "/home/t/.cache/zax/backup/2026-08-05_18-30-00";
  const PACKAGE = "/home/t/.cache/zax/packages/sfall-4.5.7z";

  /** An install with sfall 3.3 settings, and a release that ships 4.5. */
  function ready(installed: Record<string, string> = {}) {
    return new MemoryPlatform({
      home: "/home/t",
      files: {
        "/games/one/fallout2.exe": "MZ",
        "/games/one/ddraw.dll": "old sfall",
        "/games/one/ddraw.ini": "[Main]\r\nSpeedMultiInitial=200\r\n",
        ...installed,
      },
      archives: {
        [PACKAGE]: {
          "ddraw.dll": "new sfall",
          "ddraw.ini": "[Main]\r\n;How fast\r\nSpeedMultiInitial=100\r\nNewInThisRelease=1\r\n",
          "mods/sfall-mods.ini": "[mods]\r\n",
        },
      },
      downloads: { [releaseUrl("4.5")]: archiveBytes("release 4.5") },
    });
  }

  it("replaces the library and adds the files the release brings", async () => {
    const platform = ready();
    const result = await updateSfall(platform, INSTALL, "4.5", AT);

    expect(platform.textAt("/games/one/ddraw.dll")).toBe("new sfall");
    expect(platform.textAt("/games/one/mods/sfall-mods.ini")).toBe("[mods]\r\n");
    expect(result.version).toBe("4.5");
  });

  it("keeps the user's settings while taking the release's keys and comments", async () => {
    const platform = ready();
    await updateSfall(platform, INSTALL, "4.5", AT);
    expect(platform.textAt("/games/one/ddraw.ini")).toBe(
      "[Main]\r\n;How fast\r\nSpeedMultiInitial=200\r\nNewInThisRelease=1\r\n",
    );
  });

  it("keeps a setting the release dropped, rather than losing it silently", async () => {
    const platform = ready({ "/games/one/ddraw.ini": "[Main]\r\nRemovedUpstream=7\r\n" });
    await updateSfall(platform, INSTALL, "4.5", AT);
    expect(platform.textAt("/games/one/ddraw.ini")).toContain("RemovedUpstream=7");
  });

  it("backs up every file it is about to overwrite, and only those", async () => {
    const platform = ready();
    const result = await updateSfall(platform, INSTALL, "4.5", AT);

    expect(platform.textAt(`${BACKUP}/ddraw.dll`)).toBe("old sfall");
    expect(platform.textAt(`${BACKUP}/ddraw.ini`)).toBe("[Main]\r\nSpeedMultiInitial=200\r\n");
    expect(platform.textAt(`${BACKUP}/mods/sfall-mods.ini`)).toBeUndefined();
    expect([...result.replaced].sort()).toEqual(["ddraw.dll", "ddraw.ini"]);
    expect(result.backup).toBe(BACKUP);
  });

  it("clears its working directory, so a failed download does not accumulate", async () => {
    const platform = ready();
    await updateSfall(platform, INSTALL, "4.5", AT);
    expect(platform.allFiles().some((path) => path.includes("/tmp/sfall-"))).toBe(false);
  });

  it("clears its working directory even when the update fails part way", async () => {
    const platform = ready();
    await expect(updateSfall(platform, INSTALL, "9.9", AT)).rejects.toThrow();
    expect(platform.allFiles().some((path) => path.includes("/tmp/sfall-"))).toBe(false);
  });

  it("keeps the archive, so changing version again does not download it twice", async () => {
    const platform = ready();
    await updateSfall(platform, INSTALL, "4.5", AT);
    expect(platform.textAt(PACKAGE), "the release is cached by version").toBeDefined();
    expect(platform.downloaded).toHaveLength(1);

    await updateSfall(platform, INSTALL, "4.5", AT);
    expect(platform.downloaded, "the second change reads what is already there").toHaveLength(1);
  });

  it("does not download a version it already has", async () => {
    const platform = ready();
    await platform.fs.write(PACKAGE, archiveBytes("already here"));
    expect(await sfallPackage(platform, "4.5")).toBe(PACKAGE);
    expect(platform.downloaded).toEqual([]);
  });
});

/**
 * A mirror can answer with something that is not the file and still look like success: an error page served
 * with a 200, or a chunked body that stops early having declared no length. Both used to be written into the
 * cache, which was keyed on the file merely existing - so one bad answer broke that version permanently.
 */
describe("an answer that is not the archive it was meant to be", () => {
  const PACKAGE = "/home/t/.cache/zax/packages/sfall-4.5.7z";

  const withDownload = (payload: string | Uint8Array) =>
    new MemoryPlatform({
      home: "/home/t",
      files: { "/games/one/fallout2.exe": "MZ" },
      archives: { [PACKAGE]: { "ddraw.dll": "new sfall" } },
      downloads: { [releaseUrl("4.5")]: payload },
    });

  it("refuses an error page, and caches nothing", async () => {
    const platform = withDownload("<html>Mirror temporarily unavailable</html>");

    await expect(sfallPackage(platform, "4.5")).rejects.toThrow(/was not an archive/);
    expect(platform.fileAt(PACKAGE), "keeping it would break this version for good").toBeUndefined();
  });

  it("replaces a cached file that is not an archive instead of handing it out again", async () => {
    const platform = withDownload(archiveBytes("release 4.5"));
    // What a previous bad answer would have left behind.
    await platform.fs.write(PACKAGE, new TextEncoder().encode("<html>not an archive</html>"));

    expect(await sfallPackage(platform, "4.5")).toBe(PACKAGE);
    expect(platform.downloaded, "the bad copy is discarded and the real one fetched").toHaveLength(1);
    expect(platform.fileAt(PACKAGE)).toEqual(archiveBytes("release 4.5"));
  });

  it("throws away an archive that will not open, so the next attempt fetches it again", async () => {
    // Right magic, nothing readable inside - which is what a body truncated after its first bytes looks like.
    const platform = new MemoryPlatform({
      home: "/home/t",
      files: { "/games/one/fallout2.exe": "MZ", [PACKAGE]: archiveBytes("truncated") },
      downloads: { [releaseUrl("4.5")]: archiveBytes("truncated") },
    });

    await expect(updateSfall(platform, INSTALL, "4.5", new Date(2026, 7, 5))).rejects.toThrow();
    expect(platform.fileAt(PACKAGE), "a cache keyed on existence would fail the same way for ever").toBeUndefined();
  });
});

/*
  SourceForge's own file listing publishes an MD5 per release, which the archive-validity check above cannot
  see: a corrupted or substituted file that still opens as a valid 7z would pass it. Checked only when the
  feed names a digest for this version - a metadata lookup failing is not evidence the download itself is bad.
*/
describe("verifying against the published digest", () => {
  const PACKAGE = "/home/t/.cache/zax/packages/sfall-4.5.7z";
  const LIST = "https://sourceforge.net/projects/sfall/rss?path=/sfall";
  // MD5 of archiveBytes("release 4.5"), independently computed.
  const PUBLISHED_DIGEST = "8d0f601406987758465cad0bb781814c";
  const feedNaming = (digest: string) =>
    `<rss><item><title>/sfall/sfall_4.5.7z</title><media:hash algo="md5">${digest}</media:hash></item></rss>`;

  const withFeed = (feed: string) =>
    new MemoryPlatform({
      home: "/home/t",
      files: { "/games/one/fallout2.exe": "MZ" },
      downloads: { [releaseUrl("4.5")]: archiveBytes("release 4.5") },
      responses: { [LIST]: feed },
    });

  it("refuses a download that does not match the digest the feed publishes for it", async () => {
    const platform = withFeed(feedNaming("0".repeat(32)));
    await expect(sfallPackage(platform, "4.5")).rejects.toThrow(/does not match the digest/);
    expect(platform.fileAt(PACKAGE), "a mismatched download is not left behind").toBeUndefined();
  });

  it("accepts a download that matches the digest the feed publishes for it", async () => {
    const platform = withFeed(feedNaming(PUBLISHED_DIGEST));
    expect(await sfallPackage(platform, "4.5")).toBe(PACKAGE);
  });

  it("installs normally when the feed does not name this version", async () => {
    const platform = withFeed(`<rss><item><title>/sfall/sfall_4.4.7z</title></item></rss>`);
    expect(await sfallPackage(platform, "4.5")).toBe(PACKAGE);
  });

  it("installs normally when the feed itself could not be reached", async () => {
    const platform = new MemoryPlatform({
      home: "/home/t",
      files: { "/games/one/fallout2.exe": "MZ" },
      downloads: { [releaseUrl("4.5")]: archiveBytes("release 4.5") },
    });
    expect(await sfallPackage(platform, "4.5")).toBe(PACKAGE);
  });
});

/*
  The release is a third-party archive unpacked over the user's game folder, so it is judged before anything is
  extracted - by the same bounds a mod payload gets, since the two paths differ in where the archive comes from
  and not in what an archive can do.
*/
describe("what the release archive is allowed to contain", () => {
  const PACKAGE = "/home/t/.cache/zax/packages/sfall-4.5.7z";

  const listing = (entries: readonly { name: string; kind: "file" | "dir" | "link"; size: number }[]) =>
    new MemoryPlatform({
      home: "/home/t",
      files: { "/games/one/fallout2.exe": "MZ", [PACKAGE]: archiveBytes("release 4.5") },
      archives: { [PACKAGE]: { "ddraw.dll": "new sfall" } },
      listings: { [PACKAGE]: entries },
    });

  it("refuses a symbolic link, which is how an archive writes outside where it was unpacked", async () => {
    const platform = listing([{ name: "ddraw.dll", kind: "link", size: 1 }]);

    await expect(updateSfall(platform, INSTALL, "4.5", new Date(2026, 7, 5))).rejects.toThrow(/symbolic link/);
    expect(platform.textAt("/games/one/ddraw.dll"), "nothing was extracted").toBeUndefined();
  });

  it("refuses a declaration that would fill the disk", async () => {
    const platform = listing([{ name: "ddraw.dll", kind: "file", size: 9 * 1024 ** 3 }]);

    await expect(updateSfall(platform, INSTALL, "4.5", new Date(2026, 7, 5))).rejects.toThrow(/refused/);
  });

  it("refuses a path nested deeper than a release is", async () => {
    const platform = listing([{ name: `${"a/".repeat(20)}ddraw.dll`, kind: "file", size: 1 }]);

    await expect(updateSfall(platform, INSTALL, "4.5", new Date(2026, 7, 5))).rejects.toThrow(/refused/);
  });

  it("judges the archive even when only one file is being taken out of it", async () => {
    const platform = new MemoryPlatform({
      home: "/home/t",
      files: { "/games/one/fallout2.exe": "MZ", [PACKAGE]: archiveBytes("release 4.5") },
      // Readable content, so an unjudged extraction would hand back a document rather than null - which is
      // what tells this case apart from an archive that simply carries no `ddraw.ini`.
      archives: { [PACKAGE]: { "ddraw.ini": "[Main]\nBoo=1\n" } },
      listings: { [PACKAGE]: [{ name: "ddraw.ini", kind: "link", size: 1 }] },
    });

    // `sfallDefaults` absorbs a failure into "no base to merge against", so the refusal is what it returns on.
    expect(await sfallDefaults(platform, "4.5")).toBeNull();
  });
});

describe("merging against what the installed version shipped", () => {
  const AT = new Date(2026, 7, 5, 18, 30, 0);
  const OLD = "/home/t/.cache/zax/packages/sfall-4.4.7z";
  const NEW = "/home/t/.cache/zax/packages/sfall-4.5.7z";

  /**
   * An install running 4.4, whose archive is on hand, changing to 4.5. `Untouched` sits at 4.4's default and
   * `Chosen` does not, which is the distinction a two-way overlay cannot draw.
   */
  function ready(mine: string) {
    return new MemoryPlatform({
      home: "/home/t",
      files: {
        "/games/one/fallout2.exe": "MZ",
        "/games/one/ddraw.dll": library({ FileVersion: "4.4" }),
        "/games/one/ddraw.ini": mine,
      },
      archives: {
        [OLD]: { "ddraw.ini": "[Main]\r\nUntouched=1\r\nChosen=1\r\nRetired=1\r\n" },
        [NEW]: { "ddraw.dll": "new sfall", "ddraw.ini": "[Main]\r\nUntouched=2\r\nChosen=1\r\n" },
      },
      downloads: { [releaseUrl("4.4")]: archiveBytes("release 4.4"), [releaseUrl("4.5")]: archiveBytes("release 4.5") },
    });
  }

  it("takes the new default for a setting left alone, and keeps a chosen one", async () => {
    const platform = ready("[Main]\r\nUntouched=1\r\nChosen=9\r\nRetired=1\r\n");
    const result = await updateSfall(platform, INSTALL, "4.5", AT);
    const written = platform.textAt("/games/one/ddraw.ini") ?? "";

    expect(written, "4.4's default was never a choice, so 4.5's stands").toContain("Untouched=2");
    expect(written, "this one was chosen").toContain("Chosen=9");
    expect(written, "retired upstream and never touched here").not.toContain("Retired");
    expect(result.removed).toEqual([{ section: "Main", key: "Retired" }]);
    expect(result.conflicts).toEqual([]);
  });

  it("reports a setting both sides changed, and keeps the user's", async () => {
    const platform = ready("[Main]\r\nUntouched=7\r\nChosen=1\r\nRetired=1\r\n");
    const result = await updateSfall(platform, INSTALL, "4.5", AT);

    expect(platform.textAt("/games/one/ddraw.ini")).toContain("Untouched=7");
    expect(result.conflicts).toEqual([{ section: "Main", key: "Untouched", mine: "7", theirs: "2" }]);
  });

  it("keeps what a release ships, so the next update from it needs no second archive", async () => {
    const platform = ready("[Main]\r\nUntouched=1\r\nChosen=9\r\nRetired=1\r\n");
    await updateSfall(platform, INSTALL, "4.5", AT);
    const fetched = platform.downloaded.length;

    // 4.5 is what the install now runs, so it is the base the next update compares against. It was on disk
    // while this update ran, and keeping it is what turns that into no download at all.
    const base = await sfallDefaults(platform, "4.5");
    expect(base?.get("Main", "Untouched")).toBe("2");
    expect(platform.downloaded, "the base was already on hand").toHaveLength(fetched);
  });

  it("takes only its settings file out of an archive it does have to fetch for a base", async () => {
    const platform = ready("[Main]\r\nUntouched=1\r\nChosen=9\r\nRetired=1\r\n");
    await updateSfall(platform, INSTALL, "4.5", AT);

    // Unpacking the whole of 4.4 to read one file is what this used to cost.
    const forBase = platform.extracted.filter((one) => one.archive === OLD);
    expect(forBase).toHaveLength(1);
    expect(forBase[0]?.only).toEqual(["ddraw.ini"]);
  });

  it("falls back to keeping every value when the installed version is unknown", async () => {
    // No readable version on the library, so there is no base to compare against.
    const platform = ready("[Main]\r\nUntouched=1\r\nChosen=9\r\n");
    await platform.fs.write("/games/one/ddraw.dll", new TextEncoder().encode("not a library"));
    const result = await updateSfall(platform, INSTALL, "4.5", AT);

    expect(platform.textAt("/games/one/ddraw.ini"), "without a base every value carries across").toContain(
      "Untouched=1",
    );
    expect(result.conflicts).toEqual([]);
  });
});

describe("listing the versions available", () => {
  const LIST = "https://sourceforge.net/projects/sfall/rss?path=/sfall";

  it("reads them from the file listing, newest first", async () => {
    const feed = `<rss><item><title>/sfall/sfall_4.4.7z</title></item>
      <item><title>/sfall/sfall_4.5.7z</title></item>
      <item><title>/sfall/sfall_4.3.4.7z</title></item></rss>`;
    const platform = new MemoryPlatform({ responses: { [LIST]: feed } });
    expect(await listSfallVersions(platform)).toEqual(["4.5", "4.4", "4.3.4"]);
  });

  it("ignores anything in the listing that is not a release archive", async () => {
    const feed = `<rss><item><title>/sfall/sfall_4.5.7z</title></item>
      <item><title>/sfall/readme.txt</title></item>
      <item><title>/sfall/sfall_4.5.7z.asc</title></item></rss>`;
    const platform = new MemoryPlatform({ responses: { [LIST]: feed } });
    expect(await listSfallVersions(platform)).toEqual(["4.5"]);
  });
});

describe("a version that could not have come from the listing", () => {
  // The version reaches these functions across the process boundary, not only from the curated dropdown, and
  // it becomes a path segment and a URL. A traversal-shaped one must die here, not resolve somewhere.
  it("is refused before an update touches anything", async () => {
    const platform = new MemoryPlatform({ files: {} });
    await expect(updateSfall(platform, INSTALL, "../4.5")).rejects.toThrow('Not an sfall version: "../4.5"');
  });

  it("is refused before it names a cache file", async () => {
    const platform = new MemoryPlatform({ files: {} });
    await expect(sfallPackage(platform, "a/../../b")).rejects.toThrow("Not an sfall version");
  });

  it("is refused before it names a kept defaults file", async () => {
    const platform = new MemoryPlatform({ files: {} });
    await expect(sfallDefaults(platform, "..")).rejects.toThrow("Not an sfall version");
  });
});
