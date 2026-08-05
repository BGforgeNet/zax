import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { NtExecutable, NtExecutableResource } from "pe-library";
import { Resource } from "resedit";
import { installedSfallVersion, latestSfall, readSfallVersion, updateSfall } from "./sfall.js";
import type { Install } from "@zax/core";

/**
 * A PE32 image carrying nothing but a version resource. Built here rather than vendored because a real
 * `ddraw.dll` is nearly a megabyte, and what the reader has to get right is the resource, not the code.
 */
function library(values: Record<string, string>): Uint8Array {
  const stub = new ArrayBuffer(0x400);
  const view = new DataView(stub);
  const bytes = new Uint8Array(stub);
  bytes.set([0x4d, 0x5a]); // MZ
  view.setUint32(0x3c, 0x80, true); // where the PE header starts
  const pe = 0x80;
  bytes.set([0x50, 0x45, 0, 0], pe); // PE\0\0
  view.setUint16(pe + 4, 0x014c, true); // i386
  view.setUint16(pe + 20, 224, true); // size of the PE32 optional header
  view.setUint16(pe + 22, 0x2102, true); // a 32-bit executable DLL
  const optional = pe + 24;
  view.setUint16(optional, 0x10b, true); // PE32
  view.setUint32(optional + 28, 0x1000, true); // base of code
  view.setUint32(optional + 32, 0x10000000, true); // image base
  view.setUint32(optional + 36, 0x1000, true); // section alignment
  view.setUint32(optional + 40, 0x200, true); // file alignment
  view.setUint32(optional + 56, 0x2000, true); // size of image
  view.setUint32(optional + 60, 0x400, true); // size of headers
  view.setUint16(optional + 68, 2, true); // GUI subsystem
  view.setUint32(optional + 92, 16, true); // number of data directories

  const image = NtExecutable.from(stub, { ignoreCert: true });
  const resources = NtExecutableResource.from(image);
  const info = Resource.VersionInfo.createEmpty();
  info.setStringValues({ lang: 1033, codepage: 0 }, values);
  info.outputToResourceEntries(resources.entries);
  resources.outputResource(image);
  return new Uint8Array(image.generate());
}

const INSTALL: Install = { path: "/games/one", type: "fallout2" };
const FEED = "https://sourceforge.net/projects/sfall/best_release.json";

describe("reading the installed version", () => {
  it("reads it from the library's own version resource", () => {
    expect(readSfallVersion(library({ FileVersion: "4.5", ProductName: "sfall" }))).toBe("4.5");
  });

  it("reports nothing for a file that is not a library at all", () => {
    expect(readSfallVersion(new TextEncoder().encode("this is not a DLL"))).toBeNull();
  });

  it("reports nothing for a library that records no version", () => {
    expect(readSfallVersion(library({ ProductName: "something else" }))).toBeNull();
  });

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
  const RELEASE = { version: "4.5", url: "https://example/sfall_4.5.7z" };
  const AT = new Date(2026, 7, 5, 18, 30, 0);
  const BACKUP = "/home/t/.cache/zax/backup/2026-08-05_18-30-00";

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
        "/home/t/.cache/zax/tmp/sfall-2026-08-05_18-30-00/sfall.7z": {
          "ddraw.dll": "new sfall",
          "ddraw.ini": "[Main]\r\n;How fast\r\nSpeedMultiInitial=100\r\nNewInThisRelease=1\r\n",
          "mods/sfall-mods.ini": "[mods]\r\n",
        },
      },
      downloads: { [RELEASE.url]: "archive bytes" },
    });
  }

  it("replaces the library and adds the files the release brings", async () => {
    const platform = ready();
    const result = await updateSfall(platform, INSTALL, RELEASE, AT);

    expect(platform.textAt("/games/one/ddraw.dll")).toBe("new sfall");
    expect(platform.textAt("/games/one/mods/sfall-mods.ini")).toBe("[mods]\r\n");
    expect(result.version).toBe("4.5");
  });

  it("keeps the user's settings while taking the release's keys and comments", async () => {
    const platform = ready();
    await updateSfall(platform, INSTALL, RELEASE, AT);
    expect(platform.textAt("/games/one/ddraw.ini")).toBe(
      "[Main]\r\n;How fast\r\nSpeedMultiInitial=200\r\nNewInThisRelease=1\r\n",
    );
  });

  it("keeps a setting the release dropped, rather than losing it silently", async () => {
    const platform = ready({ "/games/one/ddraw.ini": "[Main]\r\nRemovedUpstream=7\r\n" });
    await updateSfall(platform, INSTALL, RELEASE, AT);
    expect(platform.textAt("/games/one/ddraw.ini")).toContain("RemovedUpstream=7");
  });

  it("backs up every file it is about to overwrite, and only those", async () => {
    const platform = ready();
    const result = await updateSfall(platform, INSTALL, RELEASE, AT);

    expect(platform.textAt(`${BACKUP}/ddraw.dll`)).toBe("old sfall");
    expect(platform.textAt(`${BACKUP}/ddraw.ini`)).toBe("[Main]\r\nSpeedMultiInitial=200\r\n");
    expect(platform.textAt(`${BACKUP}/mods/sfall-mods.ini`)).toBeUndefined();
    expect([...result.replaced].sort()).toEqual(["ddraw.dll", "ddraw.ini"]);
    expect(result.backup).toBe(BACKUP);
  });

  it("clears its working directory, so a failed download does not accumulate", async () => {
    const platform = ready();
    await updateSfall(platform, INSTALL, RELEASE, AT);
    expect(platform.allFiles().some((path) => path.includes("/tmp/sfall-"))).toBe(false);
  });

  it("clears its working directory even when the update fails part way", async () => {
    const platform = ready();
    await expect(updateSfall(platform, INSTALL, { ...RELEASE, url: "https://example/moved" }, AT)).rejects.toThrow();
    expect(platform.allFiles().some((path) => path.includes("/tmp/sfall-"))).toBe(false);
  });
});
