import { describe, expect, it } from "vitest";
import { MemoryPlatform, type MemoryOptions } from "@zax/platform/memory";
import { stamp, type Install } from "@zax/core";
import type { Platform } from "@zax/platform";
import { parseManifest } from "./manifest.js";
import { loadRecord } from "./records.js";
import type { ModRelease } from "./mod-feed.js";
import { applyModInstall, planModInstall, restoreModInstall, uninstallMod } from "./mod-install.js";

const CACHE = "/home/tester/.cache/zax";
const GAME = "/game";
const install: Install = { path: GAME, type: "fallout2" };

const workZip = (version: string) => `${CACHE}/tmp/mod-fo2tweaks-${version}/fo2tweaks.zip`;
const zipUrl = (version: string) => `https://example.test/${version}/fo2tweaks.zip`;
const payload = (version: string) => `ZIP-${version}`;

const manifestFor = (version: string, extra = "") =>
  `spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: "${version}"\ngame: fallout2\narchive: fo2tweaks.zip\n${extra}`;

const sha = async (text: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const releaseFor = async (version: string, extra = ""): Promise<ModRelease> => {
  const text = manifestFor(version, extra);
  return {
    manifest: parseManifest(new TextEncoder().encode(text)),
    manifestText: text,
    archive: { name: "fo2tweaks.zip", url: zipUrl(version), digest: `sha256:${await sha(payload(version))}` },
  };
};

const INI_147 = "[main]\r\nnew_key=5\r\nspeed=10\r\n";
const INI_15 = "[main]\r\nnew_key=7\r\nspeed=10\r\nextra=1\r\n";

const CONTENTS: Record<string, Record<string, string>> = {
  "14.7": { "zax-mod.yml": manifestFor("14.7"), "mods/fo2tweaks.dat": "DAT-14.7", "mods/fo2tweaks.ini": INI_147 },
  "15": { "zax-mod.yml": manifestFor("15"), "mods/fo2tweaks.dat": "DAT-15", "mods/fo2tweaks.ini": INI_15 },
  // 16 renames its dat, which is what makes an upgrade a replacement rather than an overlay.
  "16": { "zax-mod.yml": manifestFor("16"), "mods/fo2tweaks_core.dat": "DAT-16", "mods/fo2tweaks.ini": INI_15 },
};

/** A platform holding the game directory plus every canned release, ready for any install order. */
const gamePlatform = (options: MemoryOptions = {}) =>
  new MemoryPlatform({
    files: { [`${GAME}/fallout2.exe`]: "", ...options.files },
    downloads: Object.fromEntries(Object.keys(CONTENTS).map((v) => [zipUrl(v), payload(v)])),
    archives: Object.fromEntries(
      Object.entries(CONTENTS).map(([v, contents]) => [
        workZip(v),
        { ...contents, "readme.txt": "manual install notes" },
      ]),
    ),
    ...(options.listings ? { listings: options.listings } : {}),
  });

/** The same platform with deployment's extraction broken - what a locked file mid-deploy looks like. */
const breakingDeploy = (platform: MemoryPlatform): Platform => ({
  os: platform.os,
  fs: platform.fs,
  paths: platform.paths,
  process: platform.process,
  net: platform.net,
  registry: platform.registry,
  hash: platform.hash,
  archive: {
    ...platform.archive,
    extract: (archive, destination, options) => {
      if (destination === GAME) throw new Error("locked file");
      return platform.archive.extract(archive, destination, options);
    },
  },
});

describe("install", () => {
  it("plans, deploys only what sits under mods/, enables the order line, and records it all", async () => {
    const platform = gamePlatform();
    const release = await releaseFor("14.7");

    const plan = await planModInstall(platform, install, release);
    expect(plan.files.map((file) => file.path).sort()).toEqual(["mods/fo2tweaks.dat", "mods/fo2tweaks.ini"]);
    expect(plan.files.every((file) => !file.overwrites)).toBe(true);
    expect(plan.orderLines).toEqual(["fo2tweaks.dat"]);
    expect(plan.removes).toEqual([]);

    const outcome = await applyModInstall(platform, install, release, plan);
    expect(outcome.conflicts).toEqual([]);
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.ini`)).toBe(INI_147);
    // Manual-install convenience outside mods/ is ignored, and the manifest is never deposited in the game.
    expect(platform.textAt(`${GAME}/readme.txt`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/zax-mod.yml`)).toBeUndefined();
    const order = platform.textAt(`${GAME}/mods/mods_order.txt`) ?? "";
    expect(order).toMatch(/^fo2tweaks\.dat$/m);

    const record = await loadRecord(platform, GAME);
    expect(record.mods).toHaveLength(1);
    expect(record.mods[0]).toMatchObject({ id: "fo2tweaks", version: "14.7", complete: true });
    expect(record.mods[0]?.shipped["mods/fo2tweaks.ini"]).toBe(INI_147);
    // The working directory is cleared when the install finishes.
    expect(await platform.fs.stat(`${CACHE}/tmp/mod-fo2tweaks-14.7`)).toBeNull();
  });

  it("refuses when a manifest condition fires, matching case-insensitively, before anything is written", async () => {
    const refuse = `refuse:\n  - when: { present: [rp-marker.txt] }\n    reason: Not over this.\n`;
    const text = manifestFor("14.7", refuse);
    const release: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(text)),
      manifestText: text,
      archive: { name: "fo2tweaks.zip", url: zipUrl("14.7"), digest: `sha256:${await sha(payload("14.7"))}` },
    };
    // The plan compares the embedded manifest byte-for-byte, so the canned archive must carry this variant.
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "", [`${GAME}/RP-MARKER.TXT`]: "" },
      downloads: { [zipUrl("14.7")]: payload("14.7") },
      archives: { [workZip("14.7")]: { ...CONTENTS["14.7"]!, "zax-mod.yml": text } },
    });
    const plan = await planModInstall(platform, install, release);
    await expect(applyModInstall(platform, install, release, plan)).rejects.toThrow("Not over this.");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBeUndefined();
  });

  it("refuses a payload whose bytes do not match the stated digest, and keeps nothing", async () => {
    const platform = gamePlatform();
    const release = { ...(await releaseFor("14.7")) };
    release.archive = { ...release.archive!, digest: `sha256:${await sha("something else")}` };
    await expect(planModInstall(platform, install, release)).rejects.toThrow(/does not match the digest/);
    expect(platform.fileAt(workZip("14.7"))).toBeUndefined();
  });

  it("refuses a release that states no digest", async () => {
    const platform = gamePlatform();
    const release = { ...(await releaseFor("14.7")) };
    release.archive = { name: "fo2tweaks.zip", url: zipUrl("14.7") };
    await expect(planModInstall(platform, install, release)).rejects.toThrow(/states no digest/);
  });

  it("refuses a symlink entry and a bombed size declaration before extracting anything", async () => {
    const linky = gamePlatform({
      listings: { [workZip("14.7")]: [{ name: "mods/fo2tweaks.dat", kind: "link", size: 1 }] },
    });
    await expect(planModInstall(linky, install, await releaseFor("14.7"))).rejects.toThrow(/symbolic link/);

    const bombed = gamePlatform({
      listings: { [workZip("14.7")]: [{ name: "mods/fo2tweaks.dat", kind: "file", size: 9 * 1024 ** 3 }] },
    });
    await expect(planModInstall(bombed, install, await releaseFor("14.7"))).rejects.toThrow(/refused/);
  });

  it("judges presence the way the loader does: a differently-cased hand install is replaced, not doubled", async () => {
    const platform = gamePlatform({ files: { [`${GAME}/mods/FO2Tweaks.dat`]: "OLD" } });
    const release = await releaseFor("14.7");
    const plan = await planModInstall(platform, install, release);
    const dat = plan.files.find((file) => file.path === "mods/fo2tweaks.dat");
    expect(dat?.overwrites, "the listing offered install-over; the plan agrees").toBe(true);

    await applyModInstall(platform, install, release, plan);
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    // On a case-sensitive filesystem the old spelling would otherwise linger beside the extracted file, and
    // the loader - which folds case - would see the same mod twice.
    expect(platform.textAt(`${GAME}/mods/FO2Tweaks.dat`)).toBeUndefined();
  });

  it("refuses an archive whose embedded manifest is not the one the release published", async () => {
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: { [zipUrl("14.7")]: payload("14.7") },
      archives: { [workZip("14.7")]: { ...CONTENTS["14.7"]!, "zax-mod.yml": manifestFor("14.7") + "# altered\n" } },
    });
    await expect(planModInstall(platform, install, await releaseFor("14.7"))).rejects.toThrow(
      /not the one its release published/,
    );
  });
});

describe("upgrade", () => {
  it("merges the user's edits into the new release's file, with the recorded base telling them apart", async () => {
    const platform = gamePlatform();
    const first = await releaseFor("14.7");
    await applyModInstall(platform, install, first, await planModInstall(platform, install, first));

    // The user's one deliberate change; new_key stays at the shipped default.
    await platform.fs.write(
      `${GAME}/mods/fo2tweaks.ini`,
      new TextEncoder().encode("[main]\r\nnew_key=5\r\nspeed=99\r\n"),
    );

    const second = await releaseFor("15");
    const when = new Date(2026, 7, 12, 12, 0, 0);
    const plan = await planModInstall(platform, install, second);
    await applyModInstall(platform, install, second, plan, undefined, when);

    const ini = platform.textAt(`${GAME}/mods/fo2tweaks.ini`) ?? "";
    expect(ini).toMatch(/^speed=99$/m); // the user's value survived
    expect(ini).toMatch(/^new_key=7$/m); // an untouched default moved with the release
    expect(ini).toMatch(/^extra=1$/m); // a key the new release introduced arrived
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-15");

    // Everything replaced reached the timestamped backup first, as any save's would.
    expect(platform.textAt(`${CACHE}/backup/${stamp(when)}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");

    const record = await loadRecord(platform, GAME);
    expect(record.mods[0]).toMatchObject({ id: "fo2tweaks", version: "15", complete: true });
    expect(record.mods[0]?.shipped["mods/fo2tweaks.ini"]).toBe(INI_15);
  });

  it("replaces rather than overlays: a renamed dat does not linger in the folder or the order file", async () => {
    const platform = gamePlatform();
    const first = await releaseFor("14.7");
    await applyModInstall(platform, install, first, await planModInstall(platform, install, first));

    const renamed = await releaseFor("16");
    const plan = await planModInstall(platform, install, renamed);
    expect(plan.removes).toContain("mods/fo2tweaks.dat");
    await applyModInstall(platform, install, renamed, plan);

    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/mods/fo2tweaks_core.dat`)).toBe("DAT-16");
    const order = platform.textAt(`${GAME}/mods/mods_order.txt`) ?? "";
    expect(order).toMatch(/^fo2tweaks_core\.dat$/m);
    expect(order).not.toMatch(/^fo2tweaks\.dat$/m);
  });
});

describe("failure, retry and restore", () => {
  it("leaves a retryable state on a failed deploy, and the retry resumes without a second download", async () => {
    const platform = gamePlatform();
    const release = await releaseFor("14.7");
    const plan = await planModInstall(platform, install, release);

    await expect(applyModInstall(breakingDeploy(platform), install, release, plan)).rejects.toThrow("locked file");
    expect((await loadRecord(platform, GAME)).mods[0]).toMatchObject({ complete: false });
    // The working directory - the download included - is the retry's head start.
    expect(platform.fileAt(workZip("14.7"))).toBeDefined();

    const again = await planModInstall(platform, install, release);
    expect(platform.downloaded).toHaveLength(1);
    await applyModInstall(platform, install, release, again);
    expect((await loadRecord(platform, GAME)).mods[0]).toMatchObject({ version: "14.7", complete: true });
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
  });

  it("restores a failed upgrade to exactly the previous state, record and order lines included", async () => {
    const platform = gamePlatform();
    const first = await releaseFor("14.7");
    await applyModInstall(platform, install, first, await planModInstall(platform, install, first));
    const before = platform.textAt(`${GAME}/mods/mods_order.txt`);

    // v16 removes the old dat before deploying, so its failure leaves the most to unwind.
    const renamed = await releaseFor("16");
    const plan = await planModInstall(platform, install, renamed);
    await expect(applyModInstall(breakingDeploy(platform), install, renamed, plan)).rejects.toThrow("locked file");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBeUndefined();

    await restoreModInstall(platform, install, "fo2tweaks");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.ini`)).toBe(INI_147);
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toBe(before);
    const record = await loadRecord(platform, GAME);
    expect(record.mods[0]).toMatchObject({ id: "fo2tweaks", version: "14.7", complete: true });
    expect(await platform.fs.stat(`${CACHE}/tmp/mod-fo2tweaks-16`)).toBeNull();
  });

  it("restores a failed first install to a directory with no trace of the mod", async () => {
    const platform = gamePlatform();
    const release = await releaseFor("14.7");
    const plan = await planModInstall(platform, install, release);
    await expect(applyModInstall(breakingDeploy(platform), install, release, plan)).rejects.toThrow("locked file");

    await restoreModInstall(platform, install, "fo2tweaks");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBeUndefined();
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });
});

describe("uninstall", () => {
  it("removes exactly what install deployed, backing it up first and leaving neighbours alone", async () => {
    const platform = gamePlatform({
      files: { [`${GAME}/mods/other.dat`]: "OTHER", [`${GAME}/mods/mods_order.txt`]: "other.dat\n" },
    });
    const release = await releaseFor("14.7");
    await applyModInstall(platform, install, release, await planModInstall(platform, install, release));

    const when = new Date(2026, 7, 12, 13, 0, 0);
    const removal = await uninstallMod(platform, install, "fo2tweaks", when);
    expect([...removal.files].sort()).toEqual(["mods/fo2tweaks.dat", "mods/fo2tweaks.ini"]);

    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.ini`)).toBeUndefined();
    // The settings file is the one the settings screen edits; it reaches the backup like any save's copy.
    expect(platform.textAt(`${CACHE}/backup/${stamp(when)}/mods/fo2tweaks.ini`)).toBe(INI_147);

    const order = platform.textAt(`${GAME}/mods/mods_order.txt`) ?? "";
    expect(order).toMatch(/^other\.dat$/m);
    expect(order).not.toMatch(/fo2tweaks/);
    expect(platform.textAt(`${GAME}/mods/other.dat`)).toBe("OTHER");
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });

  it("falls back to the mods/<id>.* convention when no record exists", async () => {
    const platform = gamePlatform({
      files: {
        [`${GAME}/mods/FO2tweaks.dat`]: "DAT",
        [`${GAME}/mods/fo2tweaks.ini`]: "[main]",
        [`${GAME}/mods/mods_order.txt`]: "FO2tweaks.dat\n",
      },
    });
    const removal = await uninstallMod(platform, install, "fo2tweaks");
    expect([...removal.files].sort()).toEqual(["mods/FO2tweaks.dat", "mods/fo2tweaks.ini"]);
    expect(platform.textAt(`${GAME}/mods/FO2tweaks.dat`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).not.toMatch(/fo2tweaks/i);
  });

  it("says when there is nothing to remove", async () => {
    const platform = gamePlatform();
    await expect(uninstallMod(platform, install, "fo2tweaks")).rejects.toThrow(/nothing of "fo2tweaks"/i);
  });
});
