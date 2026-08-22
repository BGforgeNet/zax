import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import type { ReleaseAsset } from "./mod-feed.js";
import {
  DAT_TOOL_VERSION,
  assertDatHolds,
  datReadError,
  datToolFor,
  ensureDatTool,
  extractFromDat,
  noDatTool,
} from "./dat-tool.js";

const sha = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("which archive tool this host runs", () => {
  it("names a build for the systems it is published for, and none for the others", () => {
    expect(datToolFor("linux")?.name).toBe("dat3");
    expect(datToolFor("windows")?.name).toBe("dat3.exe");
    // No macOS build is published, so the offer says so rather than downloading something that cannot run.
    expect(datToolFor("macos")).toBeUndefined();
  });

  it("pins each build to the version it states and to a digest, never to whatever is newest", () => {
    for (const os of ["linux", "windows"] as const) {
      expect(datToolFor(os)?.url).toContain(`/v${DAT_TOOL_VERSION}/`);
      expect(datToolFor(os)?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("says the same thing everywhere the build is missing", () => {
    expect(noDatTool("Fallout et tu")).toContain("Fallout et tu");
    expect(noDatTool("Fallout et tu")).toMatch(/no build for this system/);
  });
});

describe("fetching the archive tool", () => {
  const BODY = "DAT3";
  const URL = "https://example.test/dat3";
  /** The real table's digest is a real binary's, which no test can produce - so the build is stated here. */
  const build = async (): Promise<ReleaseAsset> => ({ name: "dat3", url: URL, digest: `sha256:${await sha(BODY)}` });

  it("downloads the pinned build once, verifies it, and marks it runnable", async () => {
    const platform = new MemoryPlatform({ downloads: { [URL]: BODY } });
    const at = await ensureDatTool(platform, await build());
    expect(at).toContain(`dat3-${DAT_TOOL_VERSION}`);
    expect(platform.downloaded).toHaveLength(1);
    // A downloaded file arrives without a mode; one that cannot be executed is an extraction that cannot run.
    expect(platform.executable).toContain(at);

    // A copy already there at the right digest is used rather than fetched again, as every asset is.
    await ensureDatTool(platform, await build());
    expect(platform.downloaded).toHaveLength(1);
  });

  it("refuses what does not match the digest, leaving nothing behind to be run", async () => {
    const platform = new MemoryPlatform({ downloads: { [URL]: BODY } });
    const wrong: ReleaseAsset = { name: "dat3", url: URL, digest: `sha256:${"0".repeat(64)}` };
    await expect(ensureDatTool(platform, wrong)).rejects.toThrow(/does not match/);
    expect(platform.executable).toEqual([]);
  });
});

describe("running the archive tool", () => {
  const TOOL = "/cache/dat3";
  const DAT = "/fallout1/master.dat";
  const LIST = "/game/Fallout1in2/undat_files.txt";
  const INTO = "/game/Fallout1in2/data";

  const ran = (outcome: { code: number | null; output: string }) => new MemoryPlatform({ runs: { [TOOL]: outcome } });

  it("asks whether the archive can be read at all, which is the check the folder's own script makes", async () => {
    const good = ran({ code: 0, output: "" });
    expect(await datReadError(good, TOOL, DAT)).toBeNull();
    expect(good.ran[0]?.args).toEqual(["l", DAT]);

    const bad = await datReadError(ran({ code: 1, output: "Error: DAT size mismatch" }), TOOL, DAT);
    expect(bad).toContain("DAT size mismatch");
  });

  it("refuses when the archive does not hold everything the list names", async () => {
    // The gate that matters: extraction exits 0 having quietly skipped what it could not find, so what
    // decides whether this is the archive the mod asked for is the listing, which fails and names what is not.
    const platform = ran({ code: 1, output: "Files not found:\n  ART/SCENERY/NOTHERE.FRM\nError: not found" });
    await expect(assertDatHolds(platform, TOOL, DAT, LIST)).rejects.toThrow(/NOTHERE\.FRM/);
    expect(platform.ran[0]?.args).toEqual(["l", DAT, `@${LIST}`]);
  });

  it("takes an archive that holds every path the list names", async () => {
    const platform = ran({ code: 0, output: "8602 files" });
    await expect(assertDatHolds(platform, TOOL, DAT, LIST)).resolves.toBeUndefined();
  });

  it("extracts the listed paths into the directory it is given", async () => {
    const platform = ran({ code: 0, output: "Extracting 8602 files..." });
    await extractFromDat(platform, TOOL, DAT, LIST, INTO);
    expect(platform.ran[0]?.args).toEqual(["x", DAT, "-o", INTO, `@${LIST}`]);
  });

  it("reports a failed extraction with what the tool said", async () => {
    const platform = ran({ code: 1, output: "Error: Failed to read DAT file" });
    await expect(extractFromDat(platform, TOOL, DAT, LIST, INTO)).rejects.toThrow(/Failed to read DAT file/);
  });
});
