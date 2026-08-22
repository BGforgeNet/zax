import { describe, expect, it } from "vitest";
import { parseManifest } from "./manifest.js";
import type { ModRelease, ReleaseAsset } from "./mod-feed.js";
import { carryOver, chosenParts } from "./mod-parts.js";

const MANIFEST = `spec: 1
id: cassidy
name: Cassidy
version: "1.2"
game: fallout2
parts:
  - label: Head
    pick: any
    options:
      - id: head
        label: New head
        archive: cassidy_head.dat
        entries: [cassidy_head.dat]
      - id: portrait
        label: New portrait
        archive: cassidy_portrait.dat
        entries: [cassidy_portrait.dat]
  - label: Voice
    pick: one
    options:
      - id: joey
        label: Joey Bracken
        archive: cassidy_voice_joey.dat
        entries: [cassidy_voice_joey.dat]
        needs: head
      - id: tom
        label: Tom Regan
        archive: cassidy_voice_tom.dat
        entries: [cassidy_voice_tom.dat]
        needs: head
`;

const asset = (id: string): ReleaseAsset => ({ name: `${id}.dat`, url: `https://example.test/${id}.dat` });

/** A release publishing exactly the named parts - the rest of the manifest's parts resolve to nothing. */
const release = (published: readonly string[], text = MANIFEST): ModRelease => ({
  manifest: parseManifest(new TextEncoder().encode(text)),
  manifestText: text,
  manifestFromAsset: true,
  parts: Object.fromEntries(published.map((id) => [id, asset(id)])),
});

const ALL = ["head", "portrait", "joey", "tom"];

describe("chosenParts", () => {
  it("returns the selection in the order the manifest declares, whatever order it arrives in", () => {
    expect(chosenParts(release(ALL), ["joey", "head"]).map((part) => part.id)).toEqual(["head", "joey"]);
  });

  it("refuses a part the release did not publish, even though the manifest declares it", () => {
    expect(() => chosenParts(release(["head", "joey"]), ["head", "tom"])).toThrow(/does not offer a part/);
  });
});

describe("carrying a selection to the next release", () => {
  it("carries an unchanged selection without asking", () => {
    expect(carryOver(release(ALL), ["head", "joey"])).toEqual({
      selection: ["head", "joey"],
      dropped: [],
      ask: false,
    });
  });

  it("asks when there is nothing recorded - a part is never chosen on the user's behalf", () => {
    expect(carryOver(release(ALL), undefined)).toEqual({ selection: [], dropped: [], ask: true });
  });

  it("says nothing about parts for a release that has none", () => {
    const plain = `spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: "14.7"\ngame: fallout2\narchive: x.zip\n`;
    const ordinary: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(plain)),
      manifestText: plain,
      manifestFromAsset: true,
      archive: { name: "x.zip", url: "https://example.test/x.zip" },
    };
    expect(carryOver(ordinary, ["head"])).toEqual({ selection: [], dropped: [], ask: false });
  });

  it("drops a recorded part the release stopped offering, and keeps the rest", () => {
    // The portrait is an `any` option, so its going leaves nothing to decide - the upgrade names it and runs.
    expect(carryOver(release(["head", "joey", "tom"]), ["head", "portrait", "joey"])).toEqual({
      selection: ["head", "joey"],
      dropped: ["portrait"],
      ask: false,
    });
  });

  it("asks when a pick-one group lost the option that was chosen", () => {
    expect(carryOver(release(["head", "portrait", "tom"]), ["head", "joey"])).toEqual({
      selection: ["head"],
      dropped: ["joey"],
      ask: true,
    });
  });

  it("drops what the dropped part was needed by, rather than carrying a selection that cannot install", () => {
    expect(carryOver(release(["portrait", "joey", "tom"]), ["head", "joey"])).toEqual({
      selection: [],
      dropped: ["head", "joey"],
      ask: true,
    });
  });

  it("starts a newly offered part off, and does not make the upgrade ask about it", () => {
    // Recorded before the portrait existed: the two parts chosen then are the two installed now.
    expect(carryOver(release(ALL), ["head", "tom"])).toEqual({
      selection: ["head", "tom"],
      dropped: [],
      ask: false,
    });
  });

  it("asks when nothing of the recorded selection survives", () => {
    expect(carryOver(release(["portrait"]), ["head"])).toEqual({ selection: [], dropped: ["head"], ask: true });
  });
});
