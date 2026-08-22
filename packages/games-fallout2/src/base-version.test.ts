import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import { baseVersionOf, installedBaseVersion } from "./base-version.js";

describe("reading a base mod's version out of what it wrote", () => {
  it("reads every string the shipped releases carry", () => {
    // Read off the shipped artifacts rather than the build scripts, which is how the four differ at all.
    expect(baseVersionOf("FALLOUT II 1.02.34")).toEqual({ version: "34" });
    expect(baseVersionOf("FALLOUT II 1.02d  RP 2.4.34")).toEqual({ version: "2.4.34", line: "2.4" });
    expect(baseVersionOf("FALLOUT II 1.02d  RP 2.3.34")).toEqual({ version: "2.3.34", line: "2.3" });
  });

  it("reads the prefix RPU is about to start writing the same as the one it writes today", () => {
    // Every shipped release says `RP`; the current `sfall.sh` says `RPU`. Matching on the trailing version
    // rather than on the prefix is what makes that change a non-event.
    expect(baseVersionOf("FALLOUT II 1.02d  RPU 2.4.35")).toEqual({ version: "2.4.35", line: "2.4" });
  });

  it("gives a pre-split install no line rather than the wrong one", () => {
    // `2.3.3u30` is patch 30 of RP 2.3.3, from before the lines split - it has no line, and reading it as
    // line 2.3 patch 3 would offer an upgrade along a line this install was never on.
    expect(baseVersionOf("FALLOUT II 1.02d  RP 2.3.3u30")).toEqual({ version: "2.3.3u30" });
  });

  it("says nothing about a string that names no base mod", () => {
    // A vanilla install with sfall has the field too, and it says nothing about a base mod.
    expect(baseVersionOf("FALLOUT II 1.02d")).toBeNull();
    expect(baseVersionOf("")).toBeNull();
    expect(baseVersionOf("FALLOUT II 1.02d  RP")).toBeNull();
  });
});

describe("finding it in an install", () => {
  const GAME = "/game";
  const install: Install = { path: GAME, type: "fallout2rpu" };

  it("reads the key sfall writes, wherever the section sits in the file", async () => {
    const platform = new MemoryPlatform({
      files: {
        [`${GAME}/ddraw.ini`]: "[Main]\r\nX=1\r\n\r\n[Misc]\r\nVersionString=FALLOUT II 1.02d  RP 2.4.34\r\n",
      },
    });
    expect(await installedBaseVersion(platform, install)).toEqual({ version: "2.4.34", line: "2.4" });
  });

  it("answers nothing where there is no ddraw.ini, or no key in it", async () => {
    expect(await installedBaseVersion(new MemoryPlatform(), install)).toBeNull();
    const bare = new MemoryPlatform({ files: { [`${GAME}/ddraw.ini`]: "[Misc]\r\n" } });
    expect(await installedBaseVersion(bare, install)).toBeNull();
  });
});
