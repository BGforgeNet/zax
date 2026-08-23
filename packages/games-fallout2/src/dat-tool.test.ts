import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import {
  DAT_TOOL_VERSION,
  assertDatHolds,
  datReadError,
  datToolFor,
  ensureDatTool,
  extractFromDat,
  type DatTool,
  type ReadyDatTool,
} from "./dat-tool.js";

const sha = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

describe("which archive tool this host runs", () => {
  it("takes the native build for every pair one is published for", () => {
    expect(datToolFor("linux", "x64")).toMatchObject({ kind: "native", asset: { name: "dat3" } });
    expect(datToolFor("linux", "arm64")).toMatchObject({ kind: "native", asset: { name: "dat3-arm64" } });
    expect(datToolFor("windows", "x64")).toMatchObject({ kind: "native", asset: { name: "dat3.exe" } });
    // Windows on ARM runs the x64 build through the system's own emulation, which is what it did before
    // there was a module to fall back to - and keeps every host that reaches the module a POSIX one.
    expect(datToolFor("windows", "arm64")).toMatchObject({ kind: "native", asset: { name: "dat3.exe" } });
  });

  it("falls back to the module for every pair one is not, so no host is left unable to extract", () => {
    // macOS has no build of any kind upstream, and `other` is every processor ZAX names no build for. One
    // portable answer covers both.
    for (const [os, arch] of [
      ["macos", "arm64"],
      ["macos", "x64"],
      ["linux", "other"],
    ] as const) {
      expect(datToolFor(os, arch)).toMatchObject({ kind: "wasm", asset: { name: "dat3.wasm" } });
    }
  });

  it("pins every build to the version it states and to a digest, never to whatever is newest", () => {
    const seen = new Set<string | undefined>();
    for (const os of ["linux", "windows", "macos"] as const) {
      for (const arch of ["x64", "arm64", "other"] as const) {
        const { asset } = datToolFor(os, arch);
        expect(asset.url).toContain(`/v${DAT_TOOL_VERSION}/`);
        expect(asset.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        seen.add(asset.digest);
      }
    }
    // One digest per distinct build - the two Windows pairs share theirs, since they share the binary.
    expect(seen.size).toBe(4);
  });
});

describe("fetching the archive tool", () => {
  const BODY = "DAT3";
  const URL = "https://example.test/dat3";
  /** The real table's digest is a real binary's, which no test can produce - so the build is stated here. */
  const build = async (kind: DatTool["kind"] = "native"): Promise<DatTool> => ({
    kind,
    asset: { name: "dat3", url: URL, digest: `sha256:${await sha(BODY)}` },
  });

  it("downloads the pinned build once, verifies it, and marks it runnable", async () => {
    const platform = new MemoryPlatform({ downloads: { [URL]: BODY } });
    const tool = await ensureDatTool(platform, await build());
    expect(tool.path).toContain(`dat3-${DAT_TOOL_VERSION}`);
    expect(platform.downloaded).toHaveLength(1);
    // A downloaded file arrives without a mode; one that cannot be executed is an extraction that cannot run.
    expect(platform.executable).toContain(tool.path);

    // A copy already there at the right digest is used rather than fetched again, as every asset is.
    await ensureDatTool(platform, await build());
    expect(platform.downloaded).toHaveLength(1);
  });

  it("leaves the module alone, since nothing executes it directly", async () => {
    const platform = new MemoryPlatform({ downloads: { [URL]: BODY } });
    const tool = await ensureDatTool(platform, await build("wasm"));
    expect(tool.kind).toBe("wasm");
    expect(platform.executable).toEqual([]);
  });

  it("refuses what does not match the digest, leaving nothing behind to be run", async () => {
    const platform = new MemoryPlatform({ downloads: { [URL]: BODY } });
    const wrong: DatTool = { kind: "native", asset: { name: "dat3", url: URL, digest: `sha256:${"0".repeat(64)}` } };
    await expect(ensureDatTool(platform, wrong)).rejects.toThrow(/does not match/);
    expect(platform.executable).toEqual([]);
  });
});

describe("running the archive tool", () => {
  const TOOL: ReadyDatTool = { path: "/cache/dat3", kind: "native" };
  const DAT = "/fallout1/master.dat";
  const LIST = "/game/Fallout1in2/undat_files.txt";
  const INTO = "/game/Fallout1in2/data";

  const ran = (outcome: { code: number | null; output: string }, tool: ReadyDatTool = TOOL) =>
    new MemoryPlatform({ runs: { [tool.path]: outcome } });

  it("asks whether the archive can be read at all, which is the check the folder's own script makes", async () => {
    const good = ran({ code: 0, output: "" });
    expect(await datReadError(good, TOOL, DAT)).toBeNull();
    expect(good.ran[0]?.args).toEqual(["l", DAT]);

    const bad = await datReadError(ran({ code: 1, output: "Error: DAT size mismatch" }), TOOL, DAT);
    expect(bad).toContain("DAT size mismatch");
  });

  it("refuses when the archive does not hold everything the list names", async () => {
    // The gate that matters: it runs before the payload lands, where extraction's own version of this answer
    // comes after the game folder has already been written to.
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

  it("runs the module through the host that hosts one, with the same arguments either way", async () => {
    const module: ReadyDatTool = { path: "/cache/dat3.wasm", kind: "wasm" };
    const platform = ran({ code: 0, output: "Extracting 8602 files..." }, module);
    await extractFromDat(platform, module, DAT, LIST, INTO);
    expect(platform.ran[0]).toMatchObject({ program: module.path, wasm: true });
    expect(platform.ran[0]?.args).toEqual(["x", DAT, "-o", INTO, `@${LIST}`]);
  });
});
