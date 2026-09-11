import { describe, expect, it } from "vitest";
import { MemoryPlatform, type MemoryOptions } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import { parseManifest } from "./manifest.js";
import type { ModRelease } from "./mod-feed.js";
import { stamp } from "@zax/core";
import { loadRecord } from "./records.js";
import { modWorkDirectory } from "./mod-transaction.js";
import { applyBaseInstall, innoArguments, planBaseInstall } from "./mod-base.js";

const GAME = "/game";
const install: Install = { path: GAME, type: "fallout2" };
const ZIP_URL = "https://example.test/rpu_v2.4.34.zip";
const EXE_URL = "https://example.test/rpu_v2.4.34.exe";
const PAYLOAD = "ZIP-RPU";

const sha = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const MANIFEST = `spec: 1
id: rpu
name: Restoration Project, updated
version: "2.4.34"
game: fallout2
type: base
becomes: fallout2rpu
conflicts:
  - when: { present: [mods/upu.dat] }
    reason: RPU cannot be installed over UPU.
installer:
  windows:
    asset: rpu_v2.4.34.exe
    built-with: inno
  other:
    asset: rpu_v2.4.34.zip
    run: rpu-install.sh
`;

/** The release as the feed would have resolved it on this host: one route, one asset. */
const release = async (route: "windows" | "other" = "other"): Promise<ModRelease> => ({
  manifest: parseManifest(new TextEncoder().encode(MANIFEST)),
  manifestText: MANIFEST,
  installerRoute: route,
  installer: {
    route,
    asset:
      route === "other"
        ? { name: "rpu_v2.4.34.zip", url: ZIP_URL, digest: `sha256:${await sha(PAYLOAD)}`, size: PAYLOAD.length }
        : { name: "rpu_v2.4.34.exe", url: EXE_URL, digest: `sha256:${await sha("EXE")}`, size: 3 },
  },
});

const CONTENTS = {
  "rpu-install.sh": "#!/bin/bash\n",
  "mods/rpu.dat": "DAT",
  "mods_order.txt": "rpu.dat\n",
};

// The wholesale spread goes first, so the merged keys below it cannot be reinstated raw: with it last, a
// caller passing `files` silently dropped the seeded `fallout2.exe` and the failure surfaced somewhere else.
const basePlatform = (options: MemoryOptions = {}) =>
  new MemoryPlatform({
    ...options,
    files: { [`${GAME}/fallout2.exe`]: "", ...options.files },
    downloads: { [ZIP_URL]: PAYLOAD, [EXE_URL]: "EXE", ...options.downloads },
    archives: { [PAYLOAD]: CONTENTS, ...options.archives },
  });

describe("planning a base install", () => {
  it("downloads the route's asset, reads what it unpacks to, and says what the install becomes", async () => {
    const platform = basePlatform();
    const plan = await planBaseInstall(platform, install, await release());
    expect(plan).toMatchObject({
      kind: "base",
      version: "2.4.34",
      asset: "rpu_v2.4.34.zip",
      route: "other",
      download: PAYLOAD.length,
      becomes: "fallout2rpu",
    });
    // Read from the payload's own directory rather than guessed from the download's size.
    expect(plan.unpacked).toBe(Object.values(CONTENTS).join("").length);
    // Nothing of the game directory was touched by planning it.
    expect(await platform.fs.stat(`${GAME}/mods/rpu.dat`)).toBeNull();
  });

  it("has nothing to say about what a Windows installer unpacks to, and does not pretend otherwise", async () => {
    const plan = await planBaseInstall(basePlatform({ os: "windows" }), install, await release("windows"));
    expect(plan.route).toBe("windows");
    expect(plan.unpacked).toBeUndefined();
  });

  it("refuses on the manifest's own conditions before spending the download", async () => {
    const platform = basePlatform({ files: { [`${GAME}/mods/upu.dat`]: "DAT" } });
    await expect(planBaseInstall(platform, install, await release())).rejects.toThrow(/cannot be installed over UPU/);
    expect(platform.downloaded).toEqual([]);
  });

  it("refuses where the drive cannot hold the download, and again where it cannot hold the payload", async () => {
    const short = basePlatform({ freeSpace: 3 });
    await expect(planBaseInstall(short, install, await release())).rejects.toThrow(/to download and this drive/);
    expect(short.downloaded).toEqual([]);

    // Enough for the download, not for what it unpacks to - which only the payload's directory can say.
    const tight = basePlatform({ freeSpace: PAYLOAD.length + 1 });
    await expect(planBaseInstall(tight, install, await release())).rejects.toThrow(/unpacks to/);
  });

  it("measures the download against the drive the cache is on, not the game folder's", async () => {
    const platform: MemoryPlatform = basePlatform({
      freeSpace: (path) => (path.startsWith(platform.paths.cache) ? PAYLOAD.length - 1 : 1_000_000),
    });
    await expect(planBaseInstall(platform, install, await release())).rejects.toThrow(/Nothing was downloaded/);
    expect(platform.downloaded).toEqual([]);
  });

  it("measures the unpack against the room left after the download rather than before it", async () => {
    // One drive holding both the cache and the game folder, which is what a single-disk machine has: roomy
    // until the archive lands on it, and not afterwards.
    const platform: MemoryPlatform = basePlatform({
      freeSpace: () => (platform.downloaded.length === 0 ? 1_000_000 : 1),
    });
    await expect(planBaseInstall(platform, install, await release())).rejects.toThrow(/unpacks to/);
  });

  it("plans where the host cannot say how much space there is - a check that cannot run is not a failure", async () => {
    // The in-memory platform answers null unless a test says otherwise, which is the browser's answer too.
    const plan = await planBaseInstall(basePlatform(), install, await release());
    expect(plan.free).toBeUndefined();
  });

  it("refuses to install over an installer a previous run left running", async () => {
    /*
      The case the claim exists for. A ZAX that was killed part way through a base install leaves upstream's
      installer writing into the game folder with nothing watching it, and the retry offered on the next
      launch would put a second one on top. The claim it left behind names the installer rather than itself,
      so the id in it is one this machine is still running.
    */
    const platform = basePlatform({ livePids: [9876] });
    await planBaseInstall(platform, install, await release());
    // Written after the plan, so what refuses below is the claim rather than anything the plan could not do.
    const left = { host: "memory", pid: 9876, what: "Installing RPU", taken: 1 };
    await platform.fs.write(`${GAME}/.zax-lock`, new TextEncoder().encode(JSON.stringify(left)));

    await expect(applyBaseInstall(platform, install, await release())).rejects.toThrow(
      /Installing RPU is already running in this game folder on this machine, as process 9876/,
    );
    // Nothing was run: the refusal comes before the backup, the lowercasing and the installer.
    expect(platform.ran).toEqual([]);
  });

  it("refuses a release whose installer this platform does not have, naming the asset that is missing", async () => {
    const { installer: _resolved, ...nothing } = await release();
    await expect(planBaseInstall(basePlatform(), install, nothing)).rejects.toThrow(
      /names "rpu_v2\.4\.34\.zip" as its installer for this system/,
    );
  });

  it("keeps a verified download rather than paying for it twice", async () => {
    const platform = basePlatform();
    await planBaseInstall(platform, install, await release());
    await planBaseInstall(platform, install, await release());
    expect(platform.downloaded).toHaveLength(1);
  });
});

describe("a base mod over its own install", () => {
  it("does not re-run the refusal rules, which after the first install describe the install itself", async () => {
    // UPU's own rule is `present: mods/upu.dat` - the file UPU installs. Read against its own directory it
    // fires every time, so an upgrade that ran it could never install a second release.
    const OWN = MANIFEST.replace("present: [mods/upu.dat]", "present: [mods/rpu.dat]");
    const text = OWN;
    const found: ModRelease = {
      ...(await release()),
      manifest: parseManifest(new TextEncoder().encode(text)),
      manifestText: text,
    };
    const platform = basePlatform({ files: { [`${GAME}/mods/rpu.dat`]: "DAT" } });
    const onRpu: Install = { path: GAME, type: "fallout2rpu" };
    await expect(planBaseInstall(platform, onRpu, found)).resolves.toMatchObject({ version: "2.4.34" });

    // On a vanilla install the same rule is about somebody else's mod, and it still refuses.
    await expect(planBaseInstall(platform, install, found)).rejects.toThrow(/cannot be installed over UPU/);
  });
});

describe("the case-lowering pass in the plan", () => {
  it("counts what it would rename on a first install, and says nothing where there is nothing to do", async () => {
    const mixed = basePlatform({ files: { [`${GAME}/Master.dat`]: "DAT", [`${GAME}/data/Proto/Items`]: "" } });
    const plan = await planBaseInstall(mixed, install, await release());
    expect(plan.lowercasing).toBe(3);

    // A tree that is already lowercase needs no pass, and the plan does not offer to make one.
    const clean = basePlatform({ files: { [`${GAME}/master.dat`]: "DAT" } });
    expect((await planBaseInstall(clean, install, await release())).lowercasing).toBeUndefined();
  });

  it("does not lowercase an install that is already this mod's", async () => {
    // The first install did it, and what arrived afterwards is the payload's own - `mods/AmmoGlovz.ini` is
    // upstream's file, spelled the way upstream spells it.
    const platform = basePlatform({ files: { [`${GAME}/mods/AmmoGlovz.ini`]: "[main]" } });
    const onRpu: Install = { path: GAME, type: "fallout2rpu" };
    expect((await planBaseInstall(platform, onRpu, await release())).lowercasing).toBeUndefined();
  });

  it("refuses over a pair of colliding names before spending the download on it", async () => {
    const platform = basePlatform({ files: { [`${GAME}/Rpu.dat`]: "ONE", [`${GAME}/rpu.dat`]: "TWO" } });
    await expect(planBaseInstall(platform, install, await release())).rejects.toThrow(/differ only in case/);
    expect(platform.downloaded).toEqual([]);
  });
});

describe("running the installer", () => {
  const SCRIPT = `${GAME}/rpu-install.sh`;
  const USER_INI = "[Main]\r\nStartYear=2241\r\nWindowed=1\r\n";
  const SHIPPED_INI = "[Main]\r\nStartYear=-1\r\nWindowed=0\r\nExtraTweaks=1\r\n";

  /** A payload that carries the script it names, plus a config file the release ships its own version of. */
  const PAYLOAD_CONTENTS = {
    "rpu-install.sh": "#!/bin/bash\n",
    "ddraw.ini": SHIPPED_INI,
    "mods/rpu.dat": "DAT",
  };

  const installing = (outcome: { code: number | null; output: string }, files: Record<string, string> = {}) =>
    new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "", [`${GAME}/ddraw.ini`]: USER_INI, ...files },
      downloads: { [ZIP_URL]: PAYLOAD, [EXE_URL]: "EXE" },
      archives: { [PAYLOAD]: PAYLOAD_CONTENTS },
      runs: { [SCRIPT]: outcome },
    });

  it("extracts the payload, runs the script it names, and merges the user's settings back in", async () => {
    const platform = installing({ code: 0, output: "RPU installed. Backup is in backup/rpu." });
    const found = await release();
    await planBaseInstall(platform, install, found);
    const done = await applyBaseInstall(platform, install, found, undefined, new Date("2024-05-05T09:00:00Z"));

    expect(done).toMatchObject({ version: "2.4.34", becomes: "fallout2rpu" });
    expect(platform.textAt(`${GAME}/mods/rpu.dat`)).toBe("DAT");
    // Run from the game directory, because the script works in the directory it sits in - and asked to report
    // its process id, which is what the claim on the folder is handed to once the installer is the writer.
    expect(platform.ran).toEqual([
      { program: SCRIPT, args: [], options: { cwd: GAME, onStart: expect.any(Function) } },
    ]);
    // And made runnable first: a script out of an archive may arrive without its mode.
    expect(platform.executable).toContain(SCRIPT);

    // The release's file, with the user's values merged over it - and its new key kept.
    const merged = platform.textAt(`${GAME}/ddraw.ini`) ?? "";
    expect(merged).toContain("StartYear=2241");
    expect(merged).toContain("Windowed=1");
    expect(merged).toContain("ExtraTweaks=1");
    // The user's own copy reached the timestamped backup before any of that.
    const backup = `/home/tester/.cache/zax/backup/${stamp(new Date("2024-05-05T09:00:00Z"))}`;
    expect(platform.textAt(`${backup}/ddraw.ini`)).toBe(USER_INI);
  });

  it("records the install as this version of a base mod, and leaves nothing to remove", async () => {
    const platform = installing({ code: 0, output: "" });
    const found = await release();
    await planBaseInstall(platform, install, found);
    await applyBaseInstall(platform, install, found);

    const [held] = (await loadRecord(platform, GAME)).mods;
    expect(held).toMatchObject({ id: "rpu", version: "2.4.34", type: "base", complete: true, files: [] });
    // The state file as the release shipped it, which is what the next upgrade's merge compares against.
    expect(held?.shipped["ddraw.ini"]).toBe(SHIPPED_INI);
  });

  it("reports a failed installer with its code and where its backup went, and stays unfinished", async () => {
    const platform = installing({ code: 4, output: "out of space\nAborting.\n" });
    const found = await release();
    await planBaseInstall(platform, install, found);
    await expect(applyBaseInstall(platform, install, found)).rejects.toThrow(/code 4/);

    const [held] = (await loadRecord(platform, GAME)).mods;
    // Incomplete rather than absent: something is on disk and the record says so, which is what a relaunch
    // needs to say the install never finished rather than offering a restore that cannot exist.
    expect(held).toMatchObject({ id: "rpu", complete: false });
  });

  it("says what the installer said, so a failure is diagnosable rather than a number", async () => {
    const platform = installing({ code: 1, output: "line one\nline two\nno room on device\n" });
    const found = await release();
    await planBaseInstall(platform, install, found);
    await expect(applyBaseInstall(platform, install, found)).rejects.toThrow(/no room on device/);
  });

  it("lowercases the tree before the payload lands, and not on a second install", async () => {
    const platform = installing({ code: 0, output: "" }, { [`${GAME}/Master.dat`]: "DAT" });
    const found = await release();
    await planBaseInstall(platform, install, found);
    const first = await applyBaseInstall(platform, install, found);
    expect(first.renamed).toBe(1);
    expect(platform.textAt(`${GAME}/master.dat`)).toBe("DAT");

    // The install is this mod's now, so the second run leaves the payload's own spellings alone.
    await planBaseInstall(platform, install, found);
    const again = await applyBaseInstall(platform, install, found);
    expect(again.renamed).toBe(0);
  });
});

describe("a wizard the user closed", () => {
  /*
    Reachable only because ZAX shows the wizard. Inno separates the two cancellations by whether it had begun
    writing, and so does this: one leaves a folder with none of the mod in it, the other leaves one part way
    through, and telling them apart is the difference between "nothing happened" and "this cannot be undone".
  */
  // The downloaded installer's own path, which is the program the Windows route runs. Derived from the same
  // helper the install uses rather than spelled out, so a change of working directory cannot leave this
  // naming a program nothing runs - which would read as a missing canned answer rather than a wrong path.
  const EXE_AT = (() => {
    const probe = new MemoryPlatform({});
    return probe.paths.join(modWorkDirectory(probe, install, "rpu"), "rpu_v2.4.34.exe");
  })();

  const cancelling = (code: number) => basePlatform({ os: "windows", runs: { [EXE_AT]: { code, output: "" } } });

  it("says nothing was installed when it was closed before it began, and records no attempt", async () => {
    const platform = cancelling(2);
    const found = await release("windows");
    await planBaseInstall(platform, install, found);

    await expect(applyBaseInstall(platform, install, found)).rejects.toThrow(
      /cancelled, so nothing of it was installed/,
    );
    // No entry at all, where a failure leaves an incomplete one: an install that never started is not one to
    // offer a resume over, and a record saying otherwise would have the next launch offer exactly that.
    expect((await loadRecord(platform, GAME)).mods).toEqual([]);
  });

  it("reports one closed part way through as the unfinished install it is, and keeps the record", async () => {
    const platform = cancelling(5);
    const found = await release("windows");
    await planBaseInstall(platform, install, found);

    // The one message read whole rather than matched twice: a second install over the first would be a
    // different run against a folder the first one left behind, which is not what either assertion is about.
    const said = await applyBaseInstall(platform, install, found).then(
      () => "it did not fail",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(said).toContain("was cancelled part way through. The game folder is part way through the install");
    // No exit code in it: the user knows what they did, and a number reads as a fault of the installer's.
    expect(said).not.toContain("code 5");
    expect((await loadRecord(platform, GAME)).mods[0]).toMatchObject({ id: "rpu", complete: false });
  });

  it("reads those codes as cancellation on the Inno route alone, not from somebody's shell script", async () => {
    // The other route runs upstream's own script, where 2 is whatever that script decided it means.
    const platform = new MemoryPlatform({
      files: { [`${GAME}/fallout2.exe`]: "" },
      downloads: { [ZIP_URL]: PAYLOAD },
      archives: { [PAYLOAD]: CONTENTS },
      runs: { [`${GAME}/rpu-install.sh`]: { code: 2, output: "" } },
    });
    const found = await release();
    await planBaseInstall(platform, install, found);

    await expect(applyBaseInstall(platform, install, found)).rejects.toThrow(/stopped with code 2/);
  });
});

describe("the command an Inno installer is given", () => {
  it("aims it at this install and logs where ZAX can read it, and says nothing else", () => {
    expect(innoArguments("C:\\Games\\Fallout2", "C:\\log.txt")).toEqual([
      "/DIR=C:\\Games\\Fallout2",
      "/LOG=C:\\log.txt",
      "/NORESTART",
    ]);
  });

  it("neither silences the wizard nor names components, which is what leaves both to the installer", () => {
    // The two switches this deliberately omits, asserted by absence because absence is the decision: either
    // one back would put the component list under ZAX's control, and with it a copy of upstream's `inno.iss`.
    const args = innoArguments("C:\\Games\\Fallout2", "C:\\log.txt").join(" ");
    expect(args).not.toMatch(/SILENT/);
    expect(args).not.toMatch(/COMPONENTS/);
  });
});
