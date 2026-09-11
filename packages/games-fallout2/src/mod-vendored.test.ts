import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import { VENDORED_MANIFESTS, vendoredManifestFor } from "./mod-vendored.js";
import { MOD_FEEDS } from "./mod-feed.js";

const encoder = new TextEncoder();
/** Parsed the way `fetchFeed` parses it: the document states no version, and the release's tag supplies it. */
const parsed = (id: string, version: string) => {
  const text = vendoredManifestFor(id);
  if (text === undefined) throw new Error(`nothing vendored for ${id}`);
  return parseManifest(encoder.encode(text), { version });
};

describe("the vendored manifests", () => {
  it("names no installer asset, leaving each release to supply its own", () => {
    // Both BGforge mods publish `<mod>_v<version>.exe` and `.zip`, so a name written here would be a copy of
    // the version - and one upstream could change without ZAX being able to follow until its next release.
    for (const [id, version] of [
      ["rpu24", "2.4.34"],
      ["upu", "34"],
    ] as const) {
      const manifest = parsed(id, version);
      expect(manifest.installer?.windows?.asset).toBeUndefined();
      expect(manifest.installer?.other?.asset).toBeUndefined();
      expect(manifest.installer?.other?.run).toBe(`${id === "upu" ? "upu" : "rpu"}-install.sh`);
    }
  });

  it("describes each mod as the base mod it is", () => {
    expect(parsed("rpu24", "2.4.34")).toMatchObject({
      name: "Restoration Project Updated 2.4",
      version: "2.4.34",
      type: "base",
      becomes: "fallout2rpu",
      // A delegated base mod's default: its installer transforms the directory, so it wants a vanilla one.
      installOn: ["fallout2"],
    });
    expect(parsed("upu", "34")).toMatchObject({ type: "base", becomes: "fallout2upu" });
  });

  it("describes no installer choice, leaving the wizard to read its own", () => {
    // The point of carrying no tree: what the installer offers lives in upstream's `inno.iss` and is read out
    // of the executable at install time, so there is nothing here to go stale against the next release.
    for (const [id, version] of [
      ["rpu23", "2.3.34"],
      ["rpu24", "2.4.34"],
      ["upu", "34"],
    ] as const) {
      expect(parsed(id, version).installer?.windows).toEqual({ builtWith: "inno" });
    }
  });

  it("carries one document per release line, alike but for which mod each says it is", () => {
    // The two ship in lockstep from one installer: a difference between them would be a difference upstream
    // does not have, and the id is the whole of what tells a 2.3 release from a 2.4 one.
    const older = parsed("rpu23", "2.3.34");
    const newer = parsed("rpu24", "2.4.34");
    expect(older.name).toBe("Restoration Project Updated 2.3");
    expect(older.becomes).toBe(newer.becomes);
    expect(older.installer).toEqual(newer.installer);
  });

  it("describes Fallout et tu as the install it creates", () => {
    const fo1in2 = parsed("fo1in2", "1.16.3771");
    expect(fo1in2).toMatchObject({
      name: "Fallout et tu",
      type: "base",
      becomes: "fo1in2",
      // The one asset name that carries no version, so it is written out rather than left to the release.
      archive: "Fallout1in2.zip",
      creates: { directory: "Fallout1in2" },
      extractDat: { from: "fallout1", list: "undat_files.txt", into: "data" },
    });
    expect(fo1in2.inputs?.[0]).toMatchObject({ id: "fallout1", holds: "master.dat" });
    // Nothing outside the directory it makes, so it needs no vanilla install to work on.
    expect(fo1in2.installOn).toBeUndefined();
  });

  it("parses every document it carries, under the id its entry follows", () => {
    // Named rather than counted: the loops below assert nothing at all on an empty list, and this is the one
    // place that says which documents are supposed to be here.
    expect(VENDORED_MANIFESTS.map((entry) => entry.id)).toEqual(["rpu23", "rpu24", "upu", "fo1in2"]);
    for (const entry of VENDORED_MANIFESTS) {
      const manifest = parseManifest(encoder.encode(entry.text), { version: "1.2.3" });
      expect(manifest.id).toBe(entry.id);
    }
  });

  it("is reached by a feed row, and answers to nothing else", () => {
    expect(VENDORED_MANIFESTS.length).toBeGreaterThan(0);
    for (const entry of VENDORED_MANIFESTS) {
      expect(MOD_FEEDS.map((feed) => feed.id)).toContain(entry.id);
    }
    expect(vendoredManifestFor("fo2tweaks")).toBeUndefined();
  });
});
