/**
 * One specimen per shape the manifest format takes, each pinned to what it parses to.
 *
 * The format is append-only within a spec major, and this is what makes that a test rather than an intention:
 * any change that alters what an already-published manifest means breaks a specimen here, whether or not a
 * unit test happened to cover that combination of fields.
 *
 * Only valid manifests are pinned. A refusal is not append-only - adding a field turns a text that refused as
 * an unknown field into one that parses, which is exactly the change the corpus exists to permit - so the
 * refusals stay in `manifest.test.ts`, where changing one is a deliberate edit rather than a regeneration.
 */

import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type ManifestDefaults, parseManifest } from "./manifest.js";

const CORPUS = "fixtures/manifests";

/** A specimen's pinned result, and what a release would have supplied for the fields it leaves out. */
interface Pinned {
  defaults?: ManifestDefaults;
  parses: unknown;
}

const specimens = readdirSync(CORPUS)
  .filter((name) => name.endsWith(".yml"))
  .sort();

describe("the manifest corpus", () => {
  it("covers every publishing shape the format has", () => {
    expect(specimens).toEqual([
      "base.yml",
      "entries.yml",
      "full.yml",
      "minimal.yml",
      "parts.yml",
      "settings.yml",
      "tagged.yml",
    ]);
  });

  for (const name of specimens) {
    it(`reads ${name} as it is pinned`, () => {
      const pinned = JSON.parse(readFileSync(`${CORPUS}/${name.replace(/\.yml$/, ".json")}`, "utf8")) as Pinned;
      const manifest = parseManifest(new Uint8Array(readFileSync(`${CORPUS}/${name}`)), pinned.defaults ?? {});
      expect(manifest).toEqual(pinned.parses);
    });
  }

  // Anchored to a file a real repository publishes, not only to specimens written here. Its content is
  // upstream's to change, so what is asserted is that it still parses - the shapes are the specimens' job.
  it("reads the manifest FO2tweaks publishes", () => {
    const manifest = parseManifest(new Uint8Array(readFileSync("fixtures/fo2tweaks/f2mod.yml")), { version: "14.7" });
    expect(manifest.id).toBe("fo2tweaks");
    expect(manifest.settings.length).toBeGreaterThan(0);
  });
});
