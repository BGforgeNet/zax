import { describe, expect, it } from "vitest";
import { MemoryPlatform, type MemoryOptions } from "@zax/platform/memory";
import { stamp, type Install } from "@zax/core";
import type { FileSystem, Platform } from "@zax/platform";
import { parseManifest } from "./manifest.js";
import { installKey, loadRecord, saveRecord, type InstalledMod } from "./records.js";
import type { ModRelease } from "./mod-feed.js";
import { applyModInstall, planModInstall, restoreModInstall, uninstallMod } from "./mod-install.js";
import { readTransaction } from "./mod-transaction.js";

const CACHE = "/home/tester/.cache/zax";
const GAME = "/game";
const install: Install = { path: GAME, type: "fallout2" };

/** One transaction per install and mod, whatever version it carries - the keying the module itself uses. */
const WORK = `${CACHE}/tmp/mod-${installKey(GAME)}-fo2tweaks`;
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
    manifestFromAsset: true,
    archive: { name: "fo2tweaks.zip", url: zipUrl(version), digest: `sha256:${await sha(payload(version))}` },
  };
};

const INI_147 = "[main]\r\nnew_key=5\r\nspeed=10\r\n";
const INI_15 = "[main]\r\nnew_key=7\r\nspeed=10\r\nextra=1\r\n";

const CONTENTS: Record<string, Record<string, string>> = {
  "14.7": { "f2mod.yml": manifestFor("14.7"), "mods/fo2tweaks.dat": "DAT-14.7", "mods/fo2tweaks.ini": INI_147 },
  "15": { "f2mod.yml": manifestFor("15"), "mods/fo2tweaks.dat": "DAT-15", "mods/fo2tweaks.ini": INI_15 },
  // 16 renames its dat, which is what makes an upgrade a replacement rather than an overlay.
  "16": { "f2mod.yml": manifestFor("16"), "mods/fo2tweaks_core.dat": "DAT-16", "mods/fo2tweaks.ini": INI_15 },
};

/**
 * A platform holding the game directory plus every canned release, ready for any install order. The
 * archives are keyed by payload rather than by path: one transaction's working directory carries whichever
 * release it is installing, so the path is the same for all three.
 */
const gamePlatform = (options: MemoryOptions = {}) =>
  new MemoryPlatform({
    files: { [`${GAME}/fallout2.exe`]: "", ...options.files },
    downloads: Object.fromEntries(Object.keys(CONTENTS).map((v) => [zipUrl(v), payload(v)])),
    archives: Object.fromEntries(
      Object.entries(CONTENTS).map(([v, contents]) => [
        payload(v),
        { ...contents, "readme.txt": "manual install notes" },
      ]),
    ),
    ...(options.listings ? { listings: options.listings } : {}),
  });

const wrapping = (platform: MemoryPlatform, parts: Partial<Platform>): Platform => ({
  os: platform.os,
  arch: platform.arch,
  fs: platform.fs,
  paths: platform.paths,
  process: platform.process,
  net: platform.net,
  registry: platform.registry,
  hash: platform.hash,
  archive: platform.archive,
  ...parts,
});

/** The same platform with deployment's extraction broken - what a locked file mid-deploy looks like. */
const breakingDeploy = (platform: MemoryPlatform): Platform =>
  wrapping(platform, {
    archive: {
      ...platform.archive,
      extract: (archive, destination, options) => {
        if (destination === GAME) throw new Error("locked file");
        return platform.archive.extract(archive, destination, options);
      },
    },
  });

/**
 * The same platform with one write broken, which is how a failure is placed after a chosen phase: every
 * durable phase but deployment ends in a write, and `when` picks which one stops working.
 */
const breakingWrite = (platform: MemoryPlatform, when: (path: string) => boolean): Platform => {
  const fs: FileSystem = {
    ...platform.fs,
    write: (path, bytes) => {
      if (when(path)) throw new Error("locked file");
      return platform.fs.write(path, bytes);
    },
  };
  return wrapping(platform, { fs });
};

const isOrderFile = (path: string) => path === `${GAME}/mods/mods_order.txt`;
const isRecord = (path: string) => path.startsWith(`/home/tester/.config/zax/installed-mods/`);

describe("install", () => {
  it("puts a new line where the recommendation says, not at the end of the file", async () => {
    // The shipped recommendation loads fo2tweaks before InventoryFilter, so the new line goes above it
    // rather than after everything, which is where a first install used to land whatever it added.
    const platform = gamePlatform({
      files: {
        [`${GAME}/mods/rpu.dat`]: "RPU",
        [`${GAME}/mods/InventoryFilter.dat`]: "FILTER",
        [`${GAME}/mods/mods_order.txt`]: "rpu.dat\nInventoryFilter.dat\n",
      },
    });
    const release = await releaseFor("14.7");
    await applyModInstall(platform, install, release, await planModInstall(platform, install, release));
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toBe("rpu.dat\nfo2tweaks.dat\nInventoryFilter.dat\n");
  });

  it("leaves a line the file already carries where the user put it", async () => {
    const platform = gamePlatform({
      files: {
        [`${GAME}/mods/InventoryFilter.dat`]: "FILTER",
        [`${GAME}/mods/mods_order.txt`]: "InventoryFilter.dat\n; fo2tweaks.dat\n",
      },
    });
    const release = await releaseFor("14.7");
    await applyModInstall(platform, install, release, await planModInstall(platform, install, release));
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toBe("InventoryFilter.dat\nfo2tweaks.dat\n");
  });

  it("plans, deploys only what sits under mods/, enables the order line, and records it all", async () => {
    const platform = gamePlatform();
    const release = await releaseFor("14.7");

    const plan = await planModInstall(platform, install, release);
    expect(plan.files.map((file) => file.path).toSorted()).toEqual(["mods/fo2tweaks.dat", "mods/fo2tweaks.ini"]);
    expect(plan.files.every((file) => !file.overwrites)).toBe(true);
    expect(plan.orderLines).toEqual(["fo2tweaks.dat"]);
    expect(plan.removes).toEqual([]);

    const outcome = await applyModInstall(platform, install, release, plan);
    expect(outcome.conflicts).toEqual([]);
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.ini`)).toBe(INI_147);
    // Manual-install convenience outside mods/ is ignored, and the manifest is never deposited in the game.
    expect(platform.textAt(`${GAME}/readme.txt`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/f2mod.yml`)).toBeUndefined();
    const order = platform.textAt(`${GAME}/mods/mods_order.txt`) ?? "";
    expect(order).toMatch(/^fo2tweaks\.dat$/m);

    const record = await loadRecord(platform, GAME);
    expect(record.mods).toHaveLength(1);
    expect(record.mods[0]).toMatchObject({ id: "fo2tweaks", version: "14.7", complete: true });
    expect(record.mods[0]?.shipped["mods/fo2tweaks.ini"]).toBe(INI_147);
    // The working directory is cleared when the install finishes.
    expect(await platform.fs.stat(WORK)).toBeNull();
  });

  it("refuses when a manifest condition fires, matching case-insensitively, before anything is written", async () => {
    const refuse = `refuse:\n  - when: { present: [rp-marker.txt] }\n    reason: Not over this.\n`;
    const text = manifestFor("14.7", refuse);
    const release: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(text)),
      manifestText: text,
      manifestFromAsset: true,
      archive: { name: "fo2tweaks.zip", url: zipUrl("14.7"), digest: `sha256:${await sha(payload("14.7"))}` },
    };
    // The plan compares the embedded manifest byte-for-byte, so the canned archive must carry this variant.
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "", [`${GAME}/RP-MARKER.TXT`]: "" },
      downloads: { [zipUrl("14.7")]: payload("14.7") },
      archives: { [payload("14.7")]: { ...CONTENTS["14.7"]!, "f2mod.yml": text } },
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
    expect(platform.fileAt(`${WORK}/fo2tweaks.zip`)).toBeUndefined();
  });

  it("refuses a release that states no digest", async () => {
    const platform = gamePlatform();
    const release = { ...(await releaseFor("14.7")) };
    release.archive = { name: "fo2tweaks.zip", url: zipUrl("14.7") };
    await expect(planModInstall(platform, install, release)).rejects.toThrow(/states no digest/);
  });

  it("refuses a symlink entry and a bombed size declaration before extracting anything", async () => {
    const linky = gamePlatform({
      listings: { [`${WORK}/fo2tweaks.zip`]: [{ name: "mods/fo2tweaks.dat", kind: "link", size: 1 }] },
    });
    await expect(planModInstall(linky, install, await releaseFor("14.7"))).rejects.toThrow(/symbolic link/);

    const bombed = gamePlatform({
      listings: { [`${WORK}/fo2tweaks.zip`]: [{ name: "mods/fo2tweaks.dat", kind: "file", size: 9 * 1024 ** 3 }] },
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

  it("copies what a first install replaces to the timestamped backup, not only what an upgrade replaces", async () => {
    // A hand-placed dat is the common case: the working directory's copy is gone once the install finishes,
    // so the timestamped backup is the only place the original can still be. Without it a later uninstall
    // deletes the replacement with nothing to put back.
    const when = new Date(2026, 7, 12, 14, 0, 0);
    const platform = gamePlatform({ files: { [`${GAME}/mods/fo2tweaks.dat`]: "HAND" } });
    const release = await releaseFor("14.7");
    const plan = await planModInstall(platform, install, release);

    await applyModInstall(platform, install, release, plan, undefined, when);

    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    expect(platform.textAt(`${CACHE}/backup/${stamp(when)}/mods/fo2tweaks.dat`)).toBe("HAND");
    // The working directory is cleared on success, which is what makes the backup copy the only one left.
    expect(platform.textAt(`${WORK}/overwritten/mods/fo2tweaks.dat`)).toBeUndefined();
  });

  it("refuses an archive whose embedded manifest is not the one the release published", async () => {
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: { [zipUrl("14.7")]: payload("14.7") },
      archives: { [payload("14.7")]: { ...CONTENTS["14.7"]!, "f2mod.yml": manifestFor("14.7") + "# altered\n" } },
    });
    await expect(planModInstall(platform, install, await releaseFor("14.7"))).rejects.toThrow(
      /not the one its release published/,
    );
  });

  it("refuses a payload carrying no manifest when the release published one", async () => {
    const bare = Object.fromEntries(Object.entries(CONTENTS["14.7"]!).filter(([name]) => name !== "f2mod.yml"));
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: { [zipUrl("14.7")]: payload("14.7") },
      archives: { [payload("14.7")]: bare },
    });
    await expect(planModInstall(platform, install, await releaseFor("14.7"))).rejects.toThrow(/carries no f2mod\.yml/);
  });

  it("installs a payload carrying no manifest when the manifest came from the repository at the tag", async () => {
    const bare = Object.fromEntries(Object.entries(CONTENTS["14.7"]!).filter(([name]) => name !== "f2mod.yml"));
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: { [zipUrl("14.7")]: payload("14.7") },
      archives: { [payload("14.7")]: bare },
    });
    const release = { ...(await releaseFor("14.7")), manifestFromAsset: false };
    const plan = await planModInstall(platform, install, release);
    await applyModInstall(platform, install, release, plan);
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    expect((await loadRecord(platform, GAME)).mods[0]).toMatchObject({ version: "14.7", complete: true });
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
    expect(platform.fileAt(`${WORK}/fo2tweaks.zip`)).toBeDefined();

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
    expect(await platform.fs.stat(WORK)).toBeNull();
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

/**
 * An install's durable phases are journal, deploy, merge, order and commit. Deployment is covered above; the
 * three that follow it each end in a write, so breaking one write puts the failure after a chosen phase and
 * the restore that follows has to unwind everything up to it.
 */
describe("a failure after each durable phase", () => {
  /** 14.7 installed, the user's own edit in its ini, and the order file as that install left it. */
  const settled = async () => {
    const platform = gamePlatform();
    const first = await releaseFor("14.7");
    await applyModInstall(platform, install, first, await planModInstall(platform, install, first));
    await platform.fs.write(
      `${GAME}/mods/fo2tweaks.ini`,
      new TextEncoder().encode("[main]\r\nnew_key=5\r\nspeed=99\r\n"),
    );
    return { platform, order: platform.textAt(`${GAME}/mods/mods_order.txt`) };
  };

  const upgradeFailing = async (platform: MemoryPlatform, broken: Platform) => {
    const second = await releaseFor("15");
    const plan = await planModInstall(platform, install, second);
    await expect(applyModInstall(broken, install, second, plan)).rejects.toThrow("locked file");
  };

  it("after merge: restore returns the file the merge had already rewritten", async () => {
    const { platform, order } = await settled();
    await upgradeFailing(
      platform,
      breakingWrite(platform, (path) => path === `${GAME}/mods/fo2tweaks.ini`),
    );

    await restoreModInstall(platform, install, "fo2tweaks");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.ini`)).toBe("[main]\r\nnew_key=5\r\nspeed=99\r\n");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toBe(order);
    expect((await loadRecord(platform, GAME)).mods[0]).toMatchObject({ version: "14.7", complete: true });
  });

  it("after order: restore returns the order file the install had already rewritten", async () => {
    const { platform, order } = await settled();
    const renamed = await releaseFor("16");
    const plan = await planModInstall(platform, install, renamed);
    const broken = breakingWrite(platform, isOrderFile);
    await expect(applyModInstall(broken, install, renamed, plan)).rejects.toThrow("locked file");

    await restoreModInstall(platform, install, "fo2tweaks");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks_core.dat`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toBe(order);
  });

  it("after commit's own write: restore puts back a line the install enabled, not one it could infer", async () => {
    // The case a computed order cannot get right: the dat was already there and already disabled, so an
    // order rebuilt from the folder afterwards would leave it enabled - the install's doing, not the user's.
    const platform = gamePlatform({
      files: { [`${GAME}/mods/fo2tweaks.dat`]: "OLD", [`${GAME}/mods/mods_order.txt`]: "; fo2tweaks.dat\n" },
    });
    const release = await releaseFor("14.7");
    const plan = await planModInstall(platform, install, release);
    let records = 0;
    // The second record write is the commit; the first marked the install incomplete before anything landed.
    const broken = breakingWrite(platform, (path) => isRecord(path) && ++records > 1);
    await expect(applyModInstall(broken, install, release, plan)).rejects.toThrow("locked file");
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toMatch(/^fo2tweaks\.dat$/m);

    await restoreModInstall(platform, install, "fo2tweaks");
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toBe("; fo2tweaks.dat\n");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("OLD");
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });

  it("refuses to restore once the working files are gone rather than deleting what it cannot put back", async () => {
    const { platform } = await settled();
    await upgradeFailing(platform, breakingWrite(platform, isOrderFile));
    await platform.fs.remove(WORK);

    await expect(restoreModInstall(platform, install, "fo2tweaks")).rejects.toThrow(/nothing to restore from/);
    // The half-installed files are still there, which is what makes retrying the install the way out.
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-15");
  });
});

describe("a retry", () => {
  /** 14.7 installed with a user edit, then an upgrade that got as far as the order file and failed. */
  const halfUpgraded = async () => {
    const platform = gamePlatform();
    const first = await releaseFor("14.7");
    await applyModInstall(platform, install, first, await planModInstall(platform, install, first));
    await platform.fs.write(
      `${GAME}/mods/fo2tweaks.ini`,
      new TextEncoder().encode("[main]\r\nnew_key=5\r\nspeed=99\r\n"),
    );
    const second = await releaseFor("15");
    const plan = await planModInstall(platform, install, second);
    await expect(applyModInstall(breakingWrite(platform, isOrderFile), install, second, plan)).rejects.toThrow(
      "locked file",
    );
    // Deployment and the merge both landed: the directory now holds the new release, mid-transaction.
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-15");
    return platform;
  };

  it("resumes the journal the first attempt opened rather than opening a second one", async () => {
    const platform = await halfUpgraded();
    const journal = await readTransaction(platform, install, "fo2tweaks");
    expect(journal?.previous?.version, "what it replaces was captured before anything was written").toBe("14.7");

    const second = await releaseFor("15");
    await applyModInstall(platform, install, second, await planModInstall(platform, install, second));

    const ini = platform.textAt(`${GAME}/mods/fo2tweaks.ini`) ?? "";
    expect(ini).toMatch(/^speed=99$/m); // the user's value, still theirs
    // Only the recorded base tells an untouched default from a deliberate one. A retry that re-derived its
    // base from the record would find its own unfinished entry there, whose base is empty, and keep 5.
    expect(ini).toMatch(/^new_key=7$/m);
    expect((await loadRecord(platform, GAME)).mods[0]).toMatchObject({ version: "15", complete: true });
    expect(await platform.fs.stat(WORK)).toBeNull();
  });

  it("leaves the originals restorable however many attempts fail", async () => {
    const platform = await halfUpgraded();
    const second = await releaseFor("15");
    const plan = await planModInstall(platform, install, second);
    await expect(applyModInstall(breakingWrite(platform, isOrderFile), install, second, plan)).rejects.toThrow(
      "locked file",
    );

    await restoreModInstall(platform, install, "fo2tweaks");
    // What the second attempt found on disk was the first attempt's work. Set aside again, it would be what
    // came back here - the new release's dat and merged ini, restored as though they were the user's.
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.ini`)).toBe("[main]\r\nnew_key=5\r\nspeed=99\r\n");
    expect((await loadRecord(platform, GAME)).mods[0]).toMatchObject({ version: "14.7", complete: true });
  });
});

describe("two installs of one release", () => {
  const OTHER = "/game2";
  const other: Install = { path: OTHER, type: "fallout2" };

  it("keep their own recovery: finishing one does not clear what the other has to unwind", async () => {
    const platform = gamePlatform({ files: { [`${OTHER}/fallout2.exe`]: "" } });
    const release = await releaseFor("14.7");

    const failing = await planModInstall(platform, install, release);
    await expect(applyModInstall(breakingWrite(platform, isOrderFile), install, release, failing)).rejects.toThrow(
      "locked file",
    );

    // The second install runs to the end, clearing its own working directory as the last thing it does.
    await applyModInstall(platform, other, release, await planModInstall(platform, other, release));
    expect(platform.textAt(`${OTHER}/mods/fo2tweaks.dat`)).toBe("DAT-14.7");

    expect(await readTransaction(platform, install, "fo2tweaks"), "the unfinished one still has its").not.toBeNull();
    await restoreModInstall(platform, install, "fo2tweaks");
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBeUndefined();
    expect(platform.textAt(`${OTHER}/mods/fo2tweaks.dat`), "and the finished one is untouched").toBe("DAT-14.7");
  });
});

describe("a plan's fingerprint", () => {
  it("is the same twice over an unchanged folder, and different once the folder moves", async () => {
    const platform = gamePlatform();
    const release = await releaseFor("14.7");
    const first = await planModInstall(platform, install, release);
    expect((await planModInstall(platform, install, release)).fingerprint).toBe(first.fingerprint);

    // A file the payload ships now sits there, so what the install would do is no longer what was confirmed.
    await platform.fs.write(`${GAME}/mods/fo2tweaks.dat`, new TextEncoder().encode("HAND-INSTALLED"));
    expect((await planModInstall(platform, install, release)).fingerprint).not.toBe(first.fingerprint);
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
    expect([...removal.files].toSorted()).toEqual(["mods/fo2tweaks.dat", "mods/fo2tweaks.ini"]);

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
    expect([...removal.files].toSorted()).toEqual(["mods/FO2tweaks.dat", "mods/fo2tweaks.ini"]);
    expect(platform.textAt(`${GAME}/mods/FO2tweaks.dat`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).not.toMatch(/fo2tweaks/i);
  });

  it("says when there is nothing to remove", async () => {
    const platform = gamePlatform();
    await expect(uninstallMod(platform, install, "fo2tweaks")).rejects.toThrow(/nothing of "fo2tweaks"/i);
  });

  describe("judging what may be removed", () => {
    /** A record as some other version of ZAX might have left it, with the files it claims present. */
    const recorded = async (mod: Partial<InstalledMod>) => {
      const platform = gamePlatform({ files: { [`${GAME}/mods/fo2tweaks.dat`]: "DAT" } });
      await saveRecord(platform, {
        path: GAME,
        mods: [
          {
            id: "fo2tweaks",
            version: "14.7",
            complete: true,
            files: ["mods/fo2tweaks.dat"],
            manifest: manifestFor("14.7"),
            shipped: {},
            ...mod,
          },
        ],
      });
      return platform;
    };

    it("refuses a permanent mod on the record's own field, without re-reading the manifest", async () => {
      // The snapshot is unreadable; the validated field is what the refusal rests on.
      const platform = await recorded({ type: "permanent", reason: "It rewrites the engine.", manifest: "{{{" });
      await expect(uninstallMod(platform, install, "fo2tweaks")).rejects.toThrow("It rewrites the engine.");
      expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT");
    });

    it("refuses a base mod, which replaced the game rather than adding to it", async () => {
      // No declared reason and none needed: what a base mod did is not a thing that can be taken back off.
      const platform = await recorded({ type: "base", manifest: "{{{" });
      await expect(uninstallMod(platform, install, "fo2tweaks")).rejects.toThrow(/fresh copy of the game/);
      expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT");
    });

    it("refuses when nothing readable says which it is, rather than assuming it may go", async () => {
      // A record from a version this one cannot read: no type field, and a manifest written to a later spec.
      const platform = await recorded({ manifest: "spec: 99\nid: fo2tweaks\n" });
      await expect(uninstallMod(platform, install, "fo2tweaks")).rejects.toThrow(/cannot tell whether/);
      expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT");
    });

    it("still reads the manifest for a record written before the field existed", async () => {
      const platform = await recorded({});
      await expect(uninstallMod(platform, install, "fo2tweaks")).resolves.toMatchObject({
        files: ["mods/fo2tweaks.dat"],
      });
    });
  });
});

describe("a mod that declares its entries", () => {
  const FOLDER_MANIFEST = [
    "spec: 1",
    "id: inventoryfilter",
    "name: Inventory Filter",
    'version: "2.0.4"',
    "game: fallout2",
    "archive: filter.zip",
    "entries: [InventoryFilter.dat]",
    "",
  ].join("\n");

  // The payload's own shape: a folder that is named `*.dat`, which is what sfall loads it as. Nothing in
  // these paths could tell a derivation that `InventoryFilter.dat` is the entry rather than a directory
  // holding two of them.
  const FOLDER_CONTENTS = {
    "f2mod.yml": FOLDER_MANIFEST,
    "mods/InventoryFilter.dat/InvenFilter.ini": "[main]\r\nenabled=1\r\n",
    "mods/InventoryFilter.dat/scripts/gl_InvenFilter.int": "INT",
  };

  const folderPlatform = () =>
    new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: { "https://example.test/filter.zip": "ZIP-FILTER" },
      archives: { "ZIP-FILTER": FOLDER_CONTENTS },
    });

  const folderRelease = async (): Promise<ModRelease> => ({
    manifest: parseManifest(new TextEncoder().encode(FOLDER_MANIFEST)),
    manifestText: FOLDER_MANIFEST,
    manifestFromAsset: true,
    archive: {
      name: "filter.zip",
      url: "https://example.test/filter.zip",
      digest: `sha256:${await sha("ZIP-FILTER")}`,
    },
  });

  it("writes the declared order line, which no derivation from the payload's paths could find", async () => {
    const platform = folderPlatform();
    const release = await folderRelease();
    const plan = await planModInstall(platform, install, release);
    expect(plan.orderLines).toEqual(["InventoryFilter.dat"]);

    await applyModInstall(platform, install, release, plan);
    // Without the line sfall never loads the folder, so an install that skipped it reported success and did
    // nothing - the defect this field exists to close.
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toMatch(/^InventoryFilter\.dat$/m);
    expect(platform.textAt(`${GAME}/mods/InventoryFilter.dat/InvenFilter.ini`)).toBe("[main]\r\nenabled=1\r\n");
  });

  it("removes the declared order line on uninstall, where the deployed paths name no line at all", async () => {
    const platform = folderPlatform();
    const release = await folderRelease();
    await applyModInstall(platform, install, release, await planModInstall(platform, install, release));

    await uninstallMod(platform, install, "inventoryfilter");
    const order = platform.textAt(`${GAME}/mods/mods_order.txt`) ?? "";
    expect(order).not.toMatch(/InventoryFilter/);
    expect(platform.textAt(`${GAME}/mods/InventoryFilter.dat/InvenFilter.ini`)).toBeUndefined();
  });

  it("spells a nested entry the way the order file does, on the way in and on the way out", async () => {
    const text = FOLDER_MANIFEST.replace("entries: [InventoryFilter.dat]", 'entries: ["patches/extra.dat"]');
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: { "https://example.test/filter.zip": "ZIP-FILTER" },
      archives: { "ZIP-FILTER": { "f2mod.yml": text, "mods/patches/extra.dat": "DAT" } },
    });
    const release: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(text)),
      manifestText: text,
      manifestFromAsset: true,
      archive: {
        name: "filter.zip",
        url: "https://example.test/filter.zip",
        digest: `sha256:${await sha("ZIP-FILTER")}`,
      },
    };
    await applyModInstall(platform, install, release, await planModInstall(platform, install, release));
    const first = platform.textAt(`${GAME}/mods/mods_order.txt`) ?? "";
    expect(first).toMatch(/^patches\\extra\.dat$/m);

    // The order file reads its lines back with `\` separators, so a `/` here would match nothing and the
    // second install would append a duplicate the loader then loads twice.
    await applyModInstall(platform, install, release, await planModInstall(platform, install, release));
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toBe(first);
    expect(first.match(/extra\.dat/g)).toHaveLength(1);

    // And out again. The record holds the entry as the manifest spelled it, so an uninstall that took that
    // spelling to the order file matched no line and left one naming a file it had just deleted.
    await uninstallMod(platform, install, "inventoryfilter");
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`) ?? "").not.toMatch(/extra\.dat/);
  });

  it("refuses an entry the payload does not ship, rather than ordering a name nothing answers to", async () => {
    const text = FOLDER_MANIFEST.replace("entries: [InventoryFilter.dat]", "entries: [NotShipped.dat]");
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: { "https://example.test/filter.zip": "ZIP-FILTER" },
      archives: { "ZIP-FILTER": { ...FOLDER_CONTENTS, "f2mod.yml": text } },
    });
    const release: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(text)),
      manifestText: text,
      manifestFromAsset: true,
      archive: {
        name: "filter.zip",
        url: "https://example.test/filter.zip",
        digest: `sha256:${await sha("ZIP-FILTER")}`,
      },
    };
    await expect(planModInstall(platform, install, release)).rejects.toThrow(/NotShipped\.dat/);
  });
});

describe("a record a newer ZAX manages", () => {
  /** Bumps the format on disk past what this version writes - what an older ZAX opening the folder meets. */
  const laterOnDisk = async (platform: MemoryPlatform, mods: InstalledMod[]) => {
    await saveRecord(platform, { path: GAME, mods });
    const file = platform.allFiles().find((path) => path.includes("installed-mods"))!;
    const text = new TextDecoder().decode(await platform.fs.read(file));
    await platform.fs.write(file, new TextEncoder().encode(text.replace("record: 1", "record: 2")));
  };

  const recorded = (over: Partial<InstalledMod> = {}): InstalledMod => ({
    id: "fo2tweaks",
    version: "14.7",
    complete: true,
    files: ["mods/fo2tweaks.dat"],
    manifest: manifestFor("14.7"),
    shipped: {},
    ...over,
  });

  it("refuses the install before the download, rather than rewriting the record from here", async () => {
    const platform = gamePlatform();
    await laterOnDisk(platform, [recorded()]);
    const release = await releaseFor("15");
    await expect(planModInstall(platform, install, release)).rejects.toThrow(/newer version of ZAX/);
    // Nothing was fetched: the refusal is what the user gets instead of a transfer.
    expect(platform.allFiles().some((path) => path.includes("fo2tweaks.zip"))).toBe(false);
  });

  it("refuses the removal too, since it would write the record back", async () => {
    const platform = gamePlatform({ files: { [`${GAME}/mods/fo2tweaks.dat`]: "DAT" } });
    await laterOnDisk(platform, [recorded()]);
    await expect(uninstallMod(platform, install, "fo2tweaks")).rejects.toThrow(/newer version of ZAX/);
    expect(platform.textAt(`${GAME}/mods/fo2tweaks.dat`)).toBe("DAT");
  });

  it("refuses to install over an entry it cannot read, rather than recording a second one beside it", async () => {
    const platform = gamePlatform();
    // Readable id, unreadable rest: a path this version grants the mod nothing for, which is what a record
    // written after a grant was added looks like from here.
    await saveRecord(platform, { path: GAME, mods: [recorded({ files: ["appearance/hero.dat"] })] });
    const release = await releaseFor("15");
    await expect(planModInstall(platform, install, release)).rejects.toThrow(/cannot read/);
  });
});

describe("a payload that is not an archive", () => {
  // Cassidy publishes four loose `.dat` assets, and the walk-speed and Goris fixes one each.
  const DAT_URL = "https://example.test/cassidy_head.dat";
  const DAT = "CASSIDY-HEAD-BYTES";

  const bareManifest = (entries = "entries:\n  - cassidy_head.dat\n") =>
    `spec: 1\nid: cassidy\nname: Cassidy\nversion: "1.0"\ngame: fallout2\narchive: cassidy_head.dat\n${entries}`;

  const bareRelease = async (entries?: string): Promise<ModRelease> => {
    const text = bareManifest(entries);
    return {
      manifest: parseManifest(new TextEncoder().encode(text)),
      manifestText: text,
      // Published as an asset, which for an archive would demand an embedded copy - there is nowhere to put
      // one in a single file, so the check does not apply rather than failing.
      manifestFromAsset: true,
      archive: { name: "cassidy_head.dat", url: DAT_URL, digest: `sha256:${await sha(DAT)}`, size: DAT.length },
    };
  };

  const barePlatform = (files: Record<string, string> = {}) =>
    new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "", ...files },
      downloads: { [DAT_URL]: DAT },
    });

  it("installs to the entry the manifest declares, orders it, and removes it again", async () => {
    const platform = barePlatform();
    const release = await bareRelease();
    const plan = await planModInstall(platform, install, release);
    expect(plan.files).toEqual([{ path: "mods/cassidy_head.dat", size: DAT.length, overwrites: false }]);

    await applyModInstall(platform, install, release, plan);
    expect(platform.textAt(`${GAME}/mods/cassidy_head.dat`)).toBe(DAT);
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).toContain("cassidy_head.dat");
    // The id could never have reached this filename - it carries an underscore and an id may not.
    expect((await loadRecord(platform, GAME)).mods[0]?.entries).toEqual(["cassidy_head.dat"]);

    await uninstallMod(platform, install, "cassidy");
    expect(platform.textAt(`${GAME}/mods/cassidy_head.dat`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/mods/mods_order.txt`)).not.toContain("cassidy_head.dat");
  });

  it("refuses a single file the manifest does not say what to install as", async () => {
    const platform = barePlatform();
    await expect(planModInstall(platform, install, await bareRelease(""))).rejects.toThrow(/single "entries" name/);
    const two = "entries:\n  - cassidy_head.dat\n  - cassidy_voice.dat\n";
    await expect(planModInstall(platform, install, await bareRelease(two))).rejects.toThrow(/single "entries" name/);
  });

  it("checks the digest exactly as an archive's is checked", async () => {
    const platform = barePlatform();
    const release = await bareRelease();
    const wrong: ModRelease = { ...release, archive: { ...release.archive!, digest: `sha256:${"0".repeat(64)}` } };
    await expect(planModInstall(platform, install, wrong)).rejects.toThrow(/does not match the digest/);
    expect(platform.textAt(`${GAME}/mods/cassidy_head.dat`)).toBeUndefined();
  });
});

describe("a mod installed in parts", () => {
  const PARTS_WORK = `${CACHE}/tmp/mod-${installKey(GAME)}-cassidy`;
  const assetUrl = (version: string, name: string) => `https://example.test/cassidy/${version}/${name}`;
  const headZip = (version: string) => `ZIP-head-${version}`;
  const voice = (who: string, version: string) => `${who.toUpperCase()}-${version}`;

  const partsManifest = (version: string, voices = "") => `spec: 1
id: cassidy
name: Cassidy
version: "${version}"
game: fallout2
parts:
  - label: Head
    pick: any
    options:
      - id: head
        label: New head
        archive: cassidy_head.zip
        entries: [cassidy_head.dat]
  - label: Voice
    pick: one
    options:
      - id: joey
        label: Joey Bracken
        archive: cassidy_voice_joey.dat
        entries: [${voices || "cassidy_voice_joey.dat"}]
        needs: head
      - id: tom
        label: Tom Regan
        archive: cassidy_voice_tom.dat
        entries: [${voices || "cassidy_voice_tom.dat"}]
        needs: head
`;

  const partsRelease = async (version: string, voices?: string): Promise<ModRelease> => {
    const text = partsManifest(version, voices);
    const asset = async (name: string, body: string) => ({
      name,
      url: assetUrl(version, name),
      digest: `sha256:${await sha(body)}`,
      size: body.length,
    });
    return {
      manifest: parseManifest(new TextEncoder().encode(text)),
      manifestText: text,
      manifestFromAsset: true,
      parts: {
        head: await asset("cassidy_head.zip", headZip(version)),
        joey: await asset("cassidy_voice_joey.dat", voice("joey", version)),
        tom: await asset("cassidy_voice_tom.dat", voice("tom", version)),
      },
    };
  };

  const partsPlatform = (versions: readonly string[] = ["1.2"]) =>
    new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: Object.fromEntries(
        versions.flatMap((version) => [
          [assetUrl(version, "cassidy_head.zip"), headZip(version)],
          [assetUrl(version, "cassidy_voice_joey.dat"), voice("joey", version)],
          [assetUrl(version, "cassidy_voice_tom.dat"), voice("tom", version)],
        ]),
      ),
      archives: Object.fromEntries(
        versions.map((version) => [headZip(version), { "mods/cassidy_head.dat": `HEAD-${version}` }]),
      ),
    });

  const orderText = (platform: MemoryPlatform) => platform.textAt(`${GAME}/mods/mods_order.txt`) ?? "";

  /** Every file under a directory, so one platform's game folder can be re-seeded into another. */
  const listEverything = async (platform: MemoryPlatform, root: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await platform.fs.list(root)) {
      const at = `${root}/${entry.name}`;
      if (entry.kind === "dir") out.push(...(await listEverything(platform, at)));
      else out.push(at);
    }
    return out;
  };

  it("installs exactly the parts chosen, and records which they were", async () => {
    const platform = partsPlatform();
    const release = await partsRelease("1.2");
    const plan = await planModInstall(platform, install, release, ["head", "joey"]);
    expect(plan.files.map((file) => file.path)).toEqual(["mods/cassidy_head.dat", "mods/cassidy_voice_joey.dat"]);
    expect(plan.orderLines).toEqual(["cassidy_head.dat", "cassidy_voice_joey.dat"]);
    expect(plan.parts).toEqual(["head", "joey"]);

    await applyModInstall(platform, install, release, plan);
    expect(platform.textAt(`${GAME}/mods/cassidy_head.dat`)).toBe("HEAD-1.2");
    expect(platform.textAt(`${GAME}/mods/cassidy_voice_joey.dat`)).toBe("JOEY-1.2");
    expect(platform.textAt(`${GAME}/mods/cassidy_voice_tom.dat`)).toBeUndefined();
    expect(orderText(platform)).toContain("cassidy_head.dat");
    expect(orderText(platform)).toContain("cassidy_voice_joey.dat");

    const recorded = (await loadRecord(platform, GAME)).mods[0];
    expect(recorded?.parts).toEqual(["head", "joey"]);
    expect(recorded?.entries).toEqual(["cassidy_head.dat", "cassidy_voice_joey.dat"]);
    // The working directory holds both payloads while it runs, and none of it afterwards.
    expect(await platform.fs.stat(PARTS_WORK)).toBeNull();
  });

  it("treats a changed selection as the upgrade it is - deselected parts go, chosen ones arrive", async () => {
    const platform = partsPlatform(["1.2", "1.3"]);
    const first = await partsRelease("1.2");
    await applyModInstall(platform, install, first, await planModInstall(platform, install, first, ["head", "joey"]));

    const next = await partsRelease("1.3");
    const plan = await planModInstall(platform, install, next, ["head", "tom"]);
    expect(plan.removes).toEqual(["mods/cassidy_voice_joey.dat"]);
    await applyModInstall(platform, install, next, plan, undefined, new Date("2024-03-01T10:00:00Z"));

    expect(platform.textAt(`${GAME}/mods/cassidy_voice_joey.dat`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/mods/cassidy_voice_tom.dat`)).toBe("TOM-1.3");
    expect(orderText(platform)).not.toContain("cassidy_voice_joey.dat");
    expect(orderText(platform)).toContain("cassidy_voice_tom.dat");
    // What it replaced is recoverable, as anything an upgrade removes is.
    const backup = `${CACHE}/backup/${stamp(new Date("2024-03-01T10:00:00Z"))}`;
    expect(platform.textAt(`${backup}/mods/cassidy_voice_joey.dat`)).toBe("JOEY-1.2");
    expect((await loadRecord(platform, GAME)).mods[0]?.parts).toEqual(["head", "tom"]);
  });

  it("removes exactly what the selection put there", async () => {
    const platform = partsPlatform();
    const release = await partsRelease("1.2");
    await applyModInstall(
      platform,
      install,
      release,
      await planModInstall(platform, install, release, ["head", "tom"]),
    );
    await uninstallMod(platform, install, "cassidy");
    expect(platform.textAt(`${GAME}/mods/cassidy_head.dat`)).toBeUndefined();
    expect(platform.textAt(`${GAME}/mods/cassidy_voice_tom.dat`)).toBeUndefined();
    expect(orderText(platform)).not.toContain("cassidy_voice_tom.dat");
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });

  it("keeps the recorded selection when the mod stops publishing parts", async () => {
    // Cassidy's four assets becoming one file: the release has no parts, so nothing is chosen and the whole
    // payload installs. The selection stays in the record - an older ZAX reading it still needs it, and a
    // release that goes back to parts finds the choice the user made.
    const platform = partsPlatform();
    const first = await partsRelease("1.2");
    await applyModInstall(platform, install, first, await planModInstall(platform, install, first, ["head", "joey"]));

    const text = `spec: 1\nid: cassidy\nname: Cassidy\nversion: "2"\ngame: fallout2\narchive: cassidy.dat\nentries: [cassidy.dat]\n`;
    const body = "CASSIDY-ONE-FILE";
    const single: ModRelease = {
      manifest: parseManifest(new TextEncoder().encode(text)),
      manifestText: text,
      manifestFromAsset: true,
      archive: {
        name: "cassidy.dat",
        url: "https://example.test/cassidy/2/cassidy.dat",
        digest: `sha256:${await sha(body)}`,
        size: body.length,
      },
    };
    const merged = new MemoryPlatform({
      files: Object.fromEntries(
        (await listEverything(platform, GAME)).map((path) => [path, platform.textAt(path) ?? ""]),
      ),
      downloads: { "https://example.test/cassidy/2/cassidy.dat": body },
    });
    await saveRecord(merged, await loadRecord(platform, GAME));

    const plan = await planModInstall(merged, install, single);
    expect(plan.parts).toBeUndefined();
    await applyModInstall(merged, install, single, plan);
    expect(merged.textAt(`${GAME}/mods/cassidy.dat`)).toBe(body);
    expect((await loadRecord(merged, GAME)).mods[0]?.parts).toEqual(["head", "joey"]);
  });

  it("refuses a selection the release could not carry out", async () => {
    const platform = partsPlatform();
    const release = await partsRelease("1.2");
    const refused = async (selection: readonly string[], cause: RegExp) =>
      expect(planModInstall(platform, install, release, selection)).rejects.toThrow(cause);

    await refused([], /nothing to install/);
    await refused(["head", "beard"], /does not offer a part/);
    await refused(["head", "joey", "tom"], /only one/i);
    await refused(["joey"], /needs/);
  });

  it("refuses two parts that would land on one path, rather than letting the later one win", async () => {
    const platform = partsPlatform();
    // Both voices declaring the same entry: as bare payloads, both deploy to that one path.
    const release = await partsRelease("1.2", "cassidy_voice.dat");
    await expect(planModInstall(platform, install, release, ["head", "joey"])).resolves.toBeTruthy();
    const voices = release.manifest
      .parts!.flatMap((group) => group.options)
      .filter((part) => part.id !== "head")
      // Without the head there is nothing to need, and an unmet need would refuse before the collision does.
      .map(({ needs: _needs, ...part }) => part);
    const collides: ModRelease = {
      ...release,
      manifest: { ...release.manifest, parts: [{ label: "Voice", pick: "any", options: voices }] },
    };
    await expect(planModInstall(platform, install, collides, ["joey", "tom"])).rejects.toThrow(/both land on/);
  });

  it("leaves nothing installed when a later part's digest does not match", async () => {
    const platform = partsPlatform();
    const release = await partsRelease("1.2");
    const tampered: ModRelease = {
      ...release,
      parts: { ...release.parts, joey: { ...release.parts!["joey"]!, digest: `sha256:${"0".repeat(64)}` } },
    };
    await expect(planModInstall(platform, install, tampered, ["head", "joey"])).rejects.toThrow(
      /does not match the digest/,
    );
    expect(platform.textAt(`${GAME}/mods/cassidy_head.dat`)).toBeUndefined();
  });
});
