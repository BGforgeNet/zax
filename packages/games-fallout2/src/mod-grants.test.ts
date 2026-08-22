/**
 * A granted mod, from its manifest through to its removal.
 *
 * `MOD_GRANTS` ships empty: the two mods known to need a grant publish no manifest yet, so neither has an id,
 * and an id is the publisher's to declare. The table is therefore stood in for here. What is under test is
 * the mechanism it feeds - every seam that decides where a mod's files may land now asks the same question,
 * and answers it the same way for a mod with no grant.
 */

import { describe, expect, it, vi } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { stamp, type Install } from "@zax/core";
import { parseManifest } from "./manifest.js";
import { loadRecord, saveRecord } from "./records.js";
import type { ModRelease } from "./mod-feed.js";
import { applyModInstall, planModInstall, uninstallMod } from "./mod-install.js";

// Spelled out rather than read from a constant: the factory is hoisted above every declaration in the file.
vi.mock("./mod-grants.js", () => ({
  MOD_GRANTS: [{ id: "hqmusic", paths: ["data/sound/music"] }],
  grantsFor: (id: string) => (id === "hqmusic" ? ["data/sound/music"] : []),
}));

const MUSIC = "data/sound/music";

const CACHE = "/home/tester/.cache/zax";
const GAME = "/game";
const install: Install = { path: GAME, type: "fallout2" };
const URL = "https://example.test/hqmusic.zip";
const PAYLOAD = "ZIP-hqmusic";

const manifestFor = (id: string, extra = "") =>
  `spec: 1\nid: ${id}\nname: HQ music\nversion: "1.0"\ngame: fallout2\narchive: hqmusic.zip\n${extra}`;

const sha = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const releaseFor = async (id: string): Promise<ModRelease> => {
  const text = manifestFor(id);
  return {
    manifest: parseManifest(new TextEncoder().encode(text)),
    manifestText: text,
    manifestFromAsset: true,
    archive: { name: "hqmusic.zip", url: URL, digest: `sha256:${await sha(PAYLOAD)}` },
  };
};

// One track inside the grant, one file outside it - the second is ignored exactly as a file outside `mods/`
// is for a mod with no grant at all.
const CONTENTS = {
  "f2mod.yml": manifestFor("hqmusic"),
  [`${MUSIC}/01.acm`]: "TRACK-1",
  "data/sound/sfx/boom.acm": "NOT-GRANTED",
};

const gamePlatform = (files: Record<string, string> = {}) =>
  new MemoryPlatform({
    files: { [`${GAME}/fallout2.exe`]: "", ...files },
    downloads: { [URL]: PAYLOAD },
    archives: { [PAYLOAD]: CONTENTS },
  });

describe("a mod's grant", () => {
  it("lets its manifest name a path the grant covers, and refuses the same path to a mod without one", () => {
    const granted = parseManifest(new TextEncoder().encode(manifestFor("hqmusic", `state:\n  - ${MUSIC}/list.ini\n`)));
    expect(granted.state).toEqual([`${MUSIC}/list.ini`]);
    expect(() =>
      parseManifest(new TextEncoder().encode(manifestFor("fo2tweaks", `state:\n  - ${MUSIC}/list.ini\n`))),
    ).toThrow(/outside what ZAX grants fo2tweaks/);
  });

  it("does not stretch to a sibling of the granted directory", () => {
    expect(() =>
      parseManifest(new TextEncoder().encode(manifestFor("hqmusic", "state:\n  - data/sound/sfx/list.ini\n"))),
    ).toThrow(/outside what ZAX grants hqmusic/);
  });

  it("deploys, records and removes a payload that lands outside mods/", async () => {
    const platform = gamePlatform();
    const release = await releaseFor("hqmusic");
    const plan = await planModInstall(platform, install, release);
    // The ungranted sibling is not planned, so it never reaches the disk.
    expect(plan.files.map((file) => file.path)).toEqual([`${MUSIC}/01.acm`]);

    await applyModInstall(platform, install, release, plan);
    expect(platform.textAt(`${GAME}/${MUSIC}/01.acm`)).toBe("TRACK-1");
    expect(platform.textAt(`${GAME}/data/sound/sfx/boom.acm`)).toBeUndefined();
    const record = await loadRecord(platform, GAME);
    expect(record.mods[0]?.files).toEqual([`${MUSIC}/01.acm`]);

    await uninstallMod(platform, install, "hqmusic");
    expect(platform.textAt(`${GAME}/${MUSIC}/01.acm`)).toBeUndefined();
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });

  it("keeps what it replaces outside mods/, which is the case a grant creates", async () => {
    // A granted path is where a payload most often lands on someone else's file - Hero Appearance over the
    // `appearance/` dats a base mod installed, HQ music over its loose tracks - so the copy task 3.0 made
    // unconditional is what makes the grant safe to give.
    const when = new Date("2026-08-22T10:00:00Z");
    const platform = gamePlatform({ [`${GAME}/${MUSIC}/01.acm`]: "RPU-TRACK" });
    const release = await releaseFor("hqmusic");
    const plan = await planModInstall(platform, install, release);
    expect(plan.files[0]?.overwrites).toBe(true);

    await applyModInstall(platform, install, release, plan, undefined, when);
    expect(platform.textAt(`${GAME}/${MUSIC}/01.acm`)).toBe("TRACK-1");
    expect(platform.textAt(`${CACHE}/backup/${stamp(when)}/${MUSIC}/01.acm`)).toBe("RPU-TRACK");
  });

  it("drops a record entry naming a path the mod is not granted, and keeps one it is", async () => {
    const platform = gamePlatform();
    const entry = (id: string, path: string) => ({
      id,
      version: "1.0",
      complete: true,
      files: [path],
      manifest: manifestFor(id),
      shipped: {},
    });
    await saveRecord(platform, { path: GAME, mods: [entry("hqmusic", `${MUSIC}/01.acm`)] });
    expect((await loadRecord(platform, GAME)).mods.map((mod) => mod.id)).toEqual(["hqmusic"]);

    await saveRecord(platform, { path: GAME, mods: [entry("fo2tweaks", `${MUSIC}/01.acm`)] });
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });
});
