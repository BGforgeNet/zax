import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { baseVersionOf, installedBaseVersion } from "./base-version.js";

describe("reading a base mod's version out of what it wrote", () => {
  it("reads every string the shipped releases carry", () => {
    // Read off the shipped artifacts rather than the build scripts, which is how the four differ at all.
    expect(baseVersionOf("FALLOUT II 1.02.34")).toEqual({ kind: "release", version: "34" });
    expect(baseVersionOf("FALLOUT II 1.02d  RP 2.4.34")).toEqual({ kind: "release", version: "2.4.34" });
    expect(baseVersionOf("FALLOUT II 1.02d  RP 2.3.34")).toEqual({ kind: "release", version: "2.3.34" });
  });

  it("reads the prefix RPU is about to start writing the same as the one it writes today", () => {
    // Every shipped release says `RP`; the current `sfall.sh` says `RPU`. Matching on the trailing version
    // rather than on the prefix is what makes that change a non-event.
    expect(baseVersionOf("FALLOUT II 1.02d  RPU 2.4.35")).toEqual({ kind: "release", version: "2.4.35" });
  });

  it("reads the version a created install stamps, past the v its release tags carry", () => {
    // Fallout et tu's own `ddraw.ini`, as the v1.16.3771 release ships it - the version matches the tag, so
    // an update is offered against the same number the feed resolves.
    expect(baseVersionOf("FALLOUT ET TU v1.16.3771")).toEqual({ kind: "release", version: "1.16.3771" });
  });

  it("gives a pre-split install no line rather than the wrong one", () => {
    // `2.3.3u30` is patch 30 of RP 2.3.3, from before the lines split - it has no line, and reading it as
    // line 2.3 patch 3 would offer an upgrade along a line this install was never on.
    expect(baseVersionOf("FALLOUT II 1.02d  RP 2.3.3u30")).toEqual({ kind: "release", version: "2.3.3u30" });
  });

  it("reads a nightly as the commit it was built from, not as a release", () => {
    // What a UPU nightly stamps, verbatim off an install: 378 commits past v34, so no number would be right.
    expect(baseVersionOf("FALLOUT II 1.02.gitfc706658")).toEqual({ kind: "nightly", commit: "fc706658" });
    // The same for a line-carrying family, whose nightly stamps the commit where the patch number goes.
    expect(baseVersionOf("FALLOUT II 1.02d  RP 2.4.gitabc1234")).toEqual({ kind: "nightly", commit: "abc1234" });
  });

  it("does not read a release as a nightly on a hex-looking tail", () => {
    // The dot before `git` is what separates a stamped commit from a version that merely ends in letters.
    expect(baseVersionOf("FALLOUT II 1.02.34")).toEqual({ kind: "release", version: "34" });
    expect(baseVersionOf("FALLOUT II 1.02d  RP gitabc1234")).toBeNull();
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

  it("reads the key sfall writes, wherever the section sits in the file", async () => {
    const platform = new MemoryPlatform({
      files: {
        [`${GAME}/ddraw.ini`]: "[Main]\r\nX=1\r\n\r\n[Misc]\r\nVersionString=FALLOUT II 1.02d  RP 2.4.34\r\n",
      },
    });
    expect(await installedBaseVersion(platform, GAME)).toEqual({ kind: "release", version: "2.4.34" });
  });

  it("reads an install created inside another, which is where a creating mod's own copy sits", async () => {
    const platform = new MemoryPlatform({
      files: { [`${GAME}/Fallout1in2/ddraw.ini`]: "[Misc]\nVersionString=FALLOUT ET TU v1.16.3771\n" },
    });
    expect(await installedBaseVersion(platform, `${GAME}/Fallout1in2`)).toEqual({
      kind: "release",
      version: "1.16.3771",
    });
    // The host it sits in says nothing about itself, which is the point: it is still what it was.
    expect(await installedBaseVersion(platform, GAME)).toBeNull();
  });

  it("answers nothing where there is no ddraw.ini, or no key in it", async () => {
    expect(await installedBaseVersion(new MemoryPlatform(), GAME)).toBeNull();
    const bare = new MemoryPlatform({ files: { [`${GAME}/ddraw.ini`]: "[Misc]\r\n" } });
    expect(await installedBaseVersion(bare, GAME)).toBeNull();
  });
});
