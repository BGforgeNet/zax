import { describe, expect, it } from "vitest";
import { chooseBuild } from "./engine-choice.js";
import type { CachedEngine } from "./engine-release.js";
import type { InstalledEngine } from "./records.js";

const cached = (published: string): CachedEngine => ({
  release: { release: `t-${published}`, published, commit: null, asset: null },
  archive: `/cache/${published}/asset.zip`,
});

const OLD = cached("2026-07-01T00:00:00Z");
const NEW = cached("2026-08-23T09:37:22Z");

const deployed = (build: CachedEngine, pinned = false): InstalledEngine => ({
  id: "fallout2-ce",
  release: build.release.release,
  published: build.release.published,
  complete: true,
  files: ["fallout2-ce"],
  ...(pinned ? { pinned: true } : {}),
});

describe("which build a folder should run", () => {
  it("refuses when nothing is deployed and nothing is cached", () => {
    expect(chooseBuild(undefined, [], null)).toEqual({ run: "nothing" });
  });

  it("deploys the newest cached build into a folder that has none", () => {
    expect(chooseBuild(undefined, [NEW, OLD], null)).toEqual({ run: "deploy", build: NEW, pin: false });
  });

  it("runs what is there when nothing newer is cached", () => {
    expect(chooseBuild(deployed(NEW), [NEW, OLD], null)).toEqual({ run: "here", pin: false });
  });

  // The arm that makes "latest by default" true: fetching a newer build moves every unpinned folder forward.
  it("moves an unpinned folder forward when a newer build is cached", () => {
    expect(chooseBuild(deployed(OLD), [NEW, OLD], null)).toEqual({ run: "deploy", build: NEW, pin: false });
  });

  it("leaves a pinned folder on its build even when a newer one is cached", () => {
    expect(chooseBuild(deployed(OLD, true), [NEW, OLD], null)).toEqual({ run: "here", pin: true });
  });

  it("deploys and pins the build the user asked for", () => {
    expect(chooseBuild(deployed(NEW), [NEW, OLD], OLD.release.published)).toEqual({
      run: "deploy",
      build: OLD,
      pin: true,
    });
  });

  it("pins without deploying when the build asked for is the one already there", () => {
    expect(chooseBuild(deployed(OLD), [NEW, OLD], OLD.release.published)).toEqual({ run: "here", pin: true });
  });

  // The cache moved since the version list was drawn. Refusing beats running a build nobody chose.
  it("refuses a build the cache no longer holds", () => {
    expect(chooseBuild(deployed(NEW), [NEW], OLD.release.published)).toEqual({ run: "nothing" });
  });
});
