import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { library } from "./pe-fixture.js";
import {
  installedSfallVersion,
  latestSfall,
  listSfallVersions,
  releaseUrl,
  sfallPackage,
  updateSfall,
} from "./sfall.js";
import type { Install } from "@zax/core";

const INSTALL: Install = { path: "/games/one", type: "fallout2" };
const FEED = "https://sourceforge.net/projects/sfall/best_release.json";

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
      downloads: { [releaseUrl("4.5")]: "archive bytes" },
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
    await platform.fs.write(PACKAGE, new TextEncoder().encode("already here"));
    expect(await sfallPackage(platform, "4.5")).toBe(PACKAGE);
    expect(platform.downloaded).toEqual([]);
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
      downloads: { [releaseUrl("4.4")]: "old archive", [releaseUrl("4.5")]: "new archive" },
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
