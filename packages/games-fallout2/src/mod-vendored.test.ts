import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import { VENDORED_MANIFESTS, vendoredManifestFor } from "./mod-vendored.js";
import { MOD_FEEDS } from "./mod-feed.js";

const encoder = new TextEncoder();
/** Parsed the way `fetchFeed` parses it: the document states no version, and the release's tag supplies it. */
const parsed = (id: string, version: string) => {
  const text = vendoredManifestFor(id)?.(version);
  if (text === undefined) throw new Error(`nothing vendored for ${id}`);
  return parseManifest(encoder.encode(text), { version });
};

/** Every component id the manifest offers, in the order its groups declare them. */
const componentIds = (groups: readonly { options: readonly { id: string }[] }[] = []) =>
  groups.flatMap((group) => group.options.map((option) => option.id));

describe("the vendored manifests", () => {
  it("names each release's own assets, which carry the version for both BGforge mods", () => {
    // The names v2.4.34 and v34 really publish: `rpu_v2.4.34.exe` and `upu_v34.exe`.
    const rpu = parsed("rpu24", "2.4.34");
    expect(rpu.installer?.windows?.asset).toBe("rpu_v2.4.34.exe");
    expect(rpu.installer?.other).toEqual({ asset: "rpu_v2.4.34.zip", run: "rpu-install.sh" });

    const upu = parsed("upu", "34");
    expect(upu.installer?.windows?.asset).toBe("upu_v34.exe");
    expect(upu.installer?.other).toEqual({ asset: "upu_v34.zip", run: "upu-install.sh" });
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

  it("carries upstream's own component tree, backslashes and all", () => {
    const rpu = parsed("rpu24", "2.4.34");
    const ids = componentIds(rpu.installer?.windows?.components);
    // Inno spells a child inside its parent with a backslash, and the id is that spelling verbatim - a
    // double-quoted YAML scalar would refuse the document rather than carry it.
    expect(ids).toContain("translation\\english");
    expect(ids).toContain("walk_speed\\low_fps");
    expect(ids).toContain("wpn_anims\\ext_flamer");
    expect(rpu.installer?.windows?.components?.map((group) => group.label)).toEqual([
      "The mod itself",
      "Language",
      "Ammo damage formula",
      "Walk speed fix",
      "Faster derobing for Goris",
      "Weapon animations",
      "Extras",
    ]);
    // `core` is Inno's one fixed component here, and what marks it is `required` rather than the group.
    const core = rpu.installer?.windows?.components?.[0]?.options[0];
    expect(core).toMatchObject({ id: "core", required: true });
  });

  it("offers the ten languages both installers ship, at most one of them", () => {
    for (const [id, version] of [
      ["rpu24", "2.4.34"],
      ["upu", "34"],
    ] as const) {
      const language = parsed(id, version).installer?.windows?.components?.[1];
      expect(language?.label).toBe("Language");
      expect(language?.pick).toBe("one");
      expect(language?.options).toHaveLength(10);
    }
  });

  it("carries one document per release line, alike but for which mod each says it is", () => {
    // The two ship in lockstep from one installer: a difference between them would be a difference upstream
    // does not have, and the id is the whole of what tells a 2.3 release from a 2.4 one.
    const older = parsed("rpu23", "2.3.34");
    const newer = parsed("rpu24", "2.4.34");
    expect(older.name).toBe("Restoration Project Updated 2.3");
    expect(older.becomes).toBe(newer.becomes);
    expect(componentIds(older.installer?.windows?.components)).toEqual(
      componentIds(newer.installer?.windows?.components),
    );
    expect(older.installer?.windows?.asset).toBe("rpu_v2.3.34.exe");
  });

  it("gives UPU the tree it has rather than RPU's", () => {
    // UPU's inno.iss is RPU's without the extras: no world map, weapon animations, Cassidy or explosions.
    const ids = componentIds(parsed("upu", "34").installer?.windows?.components);
    expect(ids).toContain("qol");
    expect(ids).not.toContain("worldmap");
    expect(ids).not.toContain("cassidy_head");
    expect(ids.filter((id) => id.startsWith("wpn_anims"))).toEqual([]);
  });

  it("describes Fallout et tu as the install it creates", () => {
    const fo1in2 = parsed("fo1in2", "1.16.3771");
    expect(fo1in2).toMatchObject({
      name: "Fallout et tu",
      type: "base",
      becomes: "fo1in2",
      // The one asset name that carries no version, so it is written out rather than interpolated.
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
      const manifest = parseManifest(encoder.encode(entry.text("1.2.3")), { version: "1.2.3" });
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
