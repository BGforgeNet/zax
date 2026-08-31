import { describe, expect, it } from "vitest";
import { OperationCancelled } from "@zax/platform";
import { MemoryPlatform } from "@zax/platform/memory";
import { BACKEND_METHODS } from "./backend-methods.js";
import { RELEASES_PAGE, createBackend } from "./backend.js";
import type { Backend, OperationProgress } from "./backend.js";

const install = { path: "/games/one", type: "fallout2" as const };

const ENGINE_FEED = "https://api.github.com/repos/fallout2-ce/fallout2-ce/releases?per_page=30";
const ENGINE_URL = "https://example.invalid/linux.tar.gz";
const ENGINE_RELEASE = JSON.stringify([
  {
    tag_name: "continious",
    published_at: "2026-08-23T09:37:22Z",
    assets: [{ name: "fallout2-ce-linux-x64.tar.gz", size: 7, browser_download_url: ENGINE_URL }],
  },
]);

const enginePlatform = (extra: Record<string, unknown> = {}) =>
  new MemoryPlatform({
    os: "linux",
    arch: "x64",
    config: "cfg",
    cache: "cache",
    responses: { [ENGINE_FEED]: ENGINE_RELEASE },
    downloads: { [ENGINE_URL]: "payload" },
    archives: {
      payload: {
        "fallout2-ce-linux-x64/fallout2-ce": "binary",
        "fallout2-ce-linux-x64/ce.dat": "data",
      },
    },
    files: { "/games/one/fallout2.exe": "" },
    ...extra,
  });

function ready() {
  return new MemoryPlatform({
    home: "/home/t",
    files: {
      "/games/one/fallout2.exe": "MZ",
      "/games/one/fallout2.cfg": "[sound]\r\nmusic=1\r\n",
      "/home/t/.config/zax/zax.yml": "games:\n- path: /games/one\ntheme: dark\n",
    },
  });
}

const noShell = { chooseFolder: async () => null };

describe("the operation list", () => {
  it("covers the interface, which is what keeps the two halves of the boundary in step", () => {
    // The desktop build registers a channel per name and the preload builds a caller per name; a method the
    // list forgot exists on the interface, typechecks everywhere, and is simply missing at runtime.
    const backend = createBackend(new MemoryPlatform(), noShell);
    const declared = Object.keys(backend).toSorted();
    expect([...BACKEND_METHODS].toSorted()).toEqual(declared);
  });

  it("names only real methods", () => {
    const backend = createBackend(new MemoryPlatform(), noShell) as unknown as Record<string, unknown>;
    for (const name of BACKEND_METHODS) expect(typeof backend[name], name).toBe("function");
  });

  it("carries only what a message can: no argument or result is a function or a class instance", async () => {
    const backend = createBackend(ready(), noShell);
    const results = [await backend.describe(), await backend.loadState(), await backend.loadConfigFiles("/games/one")];
    // What survives JSON is what survives any transport, and this boundary is a real one in the desktop build.
    for (const result of results) expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});

describe("the operations", () => {
  it("reports the machine and its own directories", async () => {
    expect(await createBackend(ready(), noShell).describe()).toEqual({
      os: "linux",
      backupDirectory: "/home/t/.cache/zax/backup",
      debugDirectory: "/home/t/.cache/zax/debug",
      packageDirectory: "/home/t/.cache/zax/packages",
      logFile: "/home/t/.cache/zax/zax.log",
    });
  });

  it("reads an engine's own config files alongside the game's", async () => {
    // The content config sits under the directory master_patches names, so its read needs the game's config
    // file first; both come back under the name settings address them by, not the path they sit at.
    const platform = new MemoryPlatform({
      home: "/home/t",
      dirs: ["/games/one/data"],
      files: {
        "/games/one/fallout2.exe": "MZ",
        "/games/one/fallout2.cfg": "[system]\r\nmaster_patches=data\r\n[ui]\r\nextend_ap_bar=1\r\n",
        "/games/one/fission.cfg": "[enhancements]\r\nMinimap=1\r\n",
        "/games/one/data/config/game#patch.cfg": "[combat]\r\ndamage_formula=5\r\n",
      },
    });

    const held = await createBackend(platform, noShell).loadConfigFiles("/games/one");

    expect(held["fission.cfg"]).toBe("[enhancements]\r\nMinimap=1\r\n");
    expect(held["game#patch.cfg"]).toBe("[combat]\r\ndamage_formula=5\r\n");
  });

  it("writes an engine's setting back where that engine reads it", async () => {
    const game = "[system]\r\nmaster_patches=data\r\n";
    const platform = new MemoryPlatform({
      home: "/home/t",
      dirs: ["/games/one/data"],
      files: { "/games/one/fallout2.exe": "MZ", "/games/one/fallout2.cfg": game },
    });
    const backend = createBackend(platform, noShell);

    const outcome = await backend.saveConfigFiles({
      installPath: "/games/one",
      original: await backend.loadConfigFiles("/games/one"),
      changes: [{ file: "game#patch.cfg", section: "worldmap", key: "terrain_info", value: "1" }],
    });

    expect(outcome.ok).toBe(true);
    const written = new TextDecoder("latin1").decode(await platform.fs.read("/games/one/data/config/game#patch.cfg"));
    expect(written).toContain("terrain_info=1");
  });

  it("records what it wrote to a linked setting, and nothing else", async () => {
    // The base is what a later load compares against to tell which side moved. Recorded by the save itself,
    // so the two cannot come to disagree about what was written.
    const platform = new MemoryPlatform({
      home: "/home/t",
      files: {
        "/games/one/fallout2.exe": "MZ",
        "/games/one/fallout2.cfg": "[sound]\r\nmusic=1\r\n",
        "/games/one/ddraw.ini": "[Interface]\r\nExpandBarter=0\r\n",
      },
    });
    const backend = createBackend(platform, noShell);

    await backend.saveConfigFiles({
      installPath: "/games/one",
      original: await backend.loadConfigFiles("/games/one"),
      changes: [
        { file: "ddraw.ini", section: "Interface", key: "ExpandBarter", value: "1" },
        // No engine carries this one, so nothing can ever disagree with it about the value.
        { file: "ddraw.ini", section: "Misc", key: "SingleCore", value: "1" },
      ],
    });

    // Only the linked one: an address no link reaches has nothing to reconcile against.
    expect(await backend.settingsBase("/games/one")).toEqual({ "ddraw.ini|Interface|ExpandBarter": "1" });
  });

  it("answers with no base for an install it has never written to", async () => {
    expect(await createBackend(ready(), noShell).settingsBase("/games/one")).toEqual({});
  });

  it("reads the state file through to the resolved install", async () => {
    const { state } = await createBackend(ready(), noShell).loadState();
    expect(state.installs).toEqual([{ path: "/games/one", type: "fallout2" }]);
    expect(state.theme).toBe("dark");
  });

  it("launches through the plan for this machine", async () => {
    const platform = ready();
    await createBackend(platform, noShell).launch({ ...install, wine: { prefix: "/p" } }, "4.5", null, null);
    expect(platform.launched).toEqual([
      {
        program: "wine",
        args: ["fallout2.exe"],
        options: {
          cwd: "/games/one",
          env: { WINEPREFIX: "/p", WINEDLLOVERRIDES: "ddraw.dll=n,b" },
          log: "/games/one/wine.log",
        },
      },
    ]);
  });

  it("opens its own directories by name, so a caller cannot ask for another path", async () => {
    const platform = ready();
    const backend = createBackend(platform, noShell);
    for (const target of ["backup", "debug", "packages", "log"] as const) await backend.open(target);
    expect(platform.opened).toEqual([
      "/home/t/.cache/zax/backup",
      "/home/t/.cache/zax/debug",
      "/home/t/.cache/zax/packages",
      "/home/t/.cache/zax/zax.log",
    ]);
  });

  it("opens the build for this machine, resolved here so the interface never names a URL", async () => {
    const platform = new MemoryPlatform({
      home: "/home/t",
      responses: {
        "https://api.github.com/repos/BGforgeNet/zax/releases/latest": JSON.stringify({
          tag_name: "v0.9",
          html_url: "https://example/page",
          assets: [{ name: "ZAX-0.9-linux-x64.AppImage", browser_download_url: "https://example/zax" }],
        }),
      },
    });
    await createBackend(platform, noShell).open("download");
    expect(platform.opened).toEqual(["https://example/zax"]);
  });

  it("falls back to the release page when the feed cannot be reached", async () => {
    // No responses seeded, so the request fails the way an offline machine's does.
    const platform = new MemoryPlatform({ home: "/home/t" });
    await createBackend(platform, noShell).open("download");
    expect(platform.opened).toEqual([RELEASES_PAGE]);
  });

  it("empties a directory and leaves it there, so the path it shows stays valid", async () => {
    const platform = ready();
    await platform.fs.write("/home/t/.cache/zax/backup/old/fallout2.cfg", new Uint8Array([1]));
    await createBackend(platform, noShell).wipe("backup");
    expect(platform.allFiles().some((path) => path.includes("/backup/"))).toBe(false);
    expect((await platform.fs.stat("/home/t/.cache/zax/backup"))?.kind).toBe("dir");
  });

  it("leaves the other directory alone", async () => {
    const platform = ready();
    await platform.fs.write("/home/t/.cache/zax/debug/one.zip", new Uint8Array([1]));
    await createBackend(platform, noShell).wipe("backup");
    expect(platform.textAt("/home/t/.cache/zax/debug/one.zip")).toBeDefined();
  });

  it("hands the folder picker to the shell rather than choosing one itself", async () => {
    const shell = { chooseFolder: async () => "/games/picked" };
    expect(await createBackend(new MemoryPlatform(), shell).chooseFolder()).toBe("/games/picked");
  });

  it("passes on the file the folder has to hold, which is what the shell opens its picker on", async () => {
    const asked: (string | undefined)[] = [];
    const shell = {
      chooseFolder: async (holding?: string) => {
        asked.push(holding);
        return "/games/fallout";
      },
    };
    const backend = createBackend(new MemoryPlatform(), shell);
    expect(await backend.chooseFolder("master.dat")).toBe("/games/fallout");
    await backend.chooseFolder();
    expect(asked).toEqual(["master.dat", undefined]);
  });
});

describe("installing a mod", () => {
  const REPO = "BGforgeNet/FO2tweaks";
  const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=100`;
  const manifest = (version: string) =>
    `spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: "${version}"\ngame: fallout2\narchive: fo2tweaks.zip\n`;
  const payload = (version: string) => `ZIP-${version}`;
  // The digest the feed states, which the download is checked against before anything is planned.
  const digest = async (version: string) => {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload(version)));
    return `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  };
  const listing = async (versions: readonly string[]) =>
    JSON.stringify(
      await Promise.all(
        versions.map(async (version) => ({
          tag_name: `v${version}`,
          assets: [
            { name: "f2mod.yml", browser_download_url: `https://example.test/${version}/f2mod.yml` },
            {
              name: "fo2tweaks.zip",
              browser_download_url: `https://example.test/${version}/fo2tweaks.zip`,
              digest: await digest(version),
            },
          ],
        })),
      ),
    );

  const feeding = async (versions: readonly string[]) =>
    new MemoryPlatform({
      home: "/home/t",
      files: { "/games/one/fallout2.exe": "MZ" },
      responses: {
        [RELEASES]: await listing(versions),
        ...Object.fromEntries(versions.map((v) => [`https://example.test/${v}/f2mod.yml`, manifest(v)])),
      },
      downloads: Object.fromEntries(versions.map((v) => [`https://example.test/${v}/fo2tweaks.zip`, payload(v)])),
      archives: Object.fromEntries(
        versions.map((v) => [payload(v), { "f2mod.yml": manifest(v), "mods/fo2tweaks.dat": `DAT-${v}` }]),
      ),
    });

  it("runs the plan that was confirmed, and refuses one that has moved since", async () => {
    const platform = await feeding(["14.7"]);
    const backend = createBackend(platform, noShell);
    const plan = await backend.planMod(install, "fo2tweaks");

    // The folder moves between the confirmation and the click: what the plan called a new file is now an
    // overwrite, and the plan on screen no longer describes what would happen.
    await platform.fs.write("/games/one/mods/fo2tweaks.dat", new TextEncoder().encode("HAND-INSTALLED"));
    await expect(backend.installMod(install, "fo2tweaks", plan.fingerprint)).rejects.toThrow(/confirm again/);
    expect(platform.textAt("/games/one/mods/fo2tweaks.dat"), "and nothing was written").toBe("HAND-INSTALLED");

    const fresh = await backend.planMod(install, "fo2tweaks");
    await expect(backend.installMod(install, "fo2tweaks", fresh.fingerprint)).resolves.toMatchObject({
      version: "14.7",
    });
  });

  it("finishes the version an unfinished install started, whatever the feed has published since", async () => {
    // Both releases are downloadable throughout - only what the feed lists changes - so installing the newer
    // one would succeed here. What stops it is the pin, not a missing payload.
    const platform = await feeding(["14.7", "15"]);
    let published = ["14.7"];
    const feed = {
      ...platform,
      net: {
        download: platform.net.download,
        fetchText: async (url: string) => (url === RELEASES ? await listing(published) : platform.net.fetchText(url)),
      },
    };

    const plan = await createBackend(feed, noShell).planMod(install, "fo2tweaks");
    const breaking = {
      ...feed,
      fs: {
        ...platform.fs,
        write: async (path: string, bytes: Uint8Array) => {
          if (path.endsWith("mods_order.txt")) throw new Error("locked file");
          return platform.fs.write(path, bytes);
        },
      },
    };
    await expect(createBackend(breaking, noShell).installMod(install, "fo2tweaks", plan.fingerprint)).rejects.toThrow(
      "locked file",
    );

    // 15 is published while the transaction sits unfinished, and the cached listing is dropped so the feed
    // is genuinely re-read. The retry is still 14.7's: the copies waiting to be put back are that release's.
    published = ["15", "14.7"];
    await platform.fs.remove("/home/t/.cache/zax/feeds/BGforgeNet-FO2tweaks.json");

    const retry = await createBackend(feed, noShell).planMod(install, "fo2tweaks");
    await expect(
      createBackend(feed, noShell).installMod(install, "fo2tweaks", retry.fingerprint),
    ).resolves.toMatchObject({ version: "14.7" });
    expect(platform.textAt("/games/one/mods/fo2tweaks.dat")).toBe("DAT-14.7");
  });
});

describe("stopping a long operation", () => {
  /*
    Only the transfer takes notice of a cancel, so the interface has to be told which steps those are. Inferring
    it from the byte counts being present would put the button on any step that happened to have them.
  */
  it("declares which steps a cancel would reach", async () => {
    const reports: OperationProgress[] = [];
    const shell = { chooseFolder: async () => null, report: (at: OperationProgress) => reports.push(at) };
    await createBackend(enginePlatform(), shell).fetchEngine("fallout2-ce", null);

    expect(
      reports.some((at) => at.cancellable === true && at.received !== undefined),
      "the transfer says so",
    ).toBe(true);
    expect(
      reports.some((at) => at.cancellable === false),
      "and the steps around it say the opposite",
    ).toBe(true);
  });

  /*
    The wiring the whole feature rests on: the operation mints a signal, the transfer is given it, and `cancel`
    is what aborts it. Held open at the download so the cancel lands while it is running, which is the only
    moment it means anything.
  */
  it("hands the transfer a signal that cancel aborts", async () => {
    const platform = enginePlatform();
    let seen: AbortSignal | undefined;
    let reached = () => {};
    let release = () => {};
    const atDownload = new Promise<void>((resolve) => (reached = resolve));
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = platform.net.download.bind(platform.net);
    platform.net.download = async (url, destination, options) => {
      seen = options?.signal;
      reached();
      await held;
      return real(url, destination, options);
    };

    const backend = createBackend(platform, noShell);
    const fetching = backend.fetchEngine("fallout2-ce", null);
    await atDownload;

    expect(seen, "the transfer was given one").toBeDefined();
    expect(seen?.aborted, "and it is untouched until asked").toBe(false);

    await backend.cancel();
    expect(seen?.aborted).toBe(true);

    // And the operation ends as cancelled rather than as a result or a network failure, all the way up.
    release();
    await expect(fetching).rejects.toBeInstanceOf(OperationCancelled);
  });

  it("does nothing rather than failing when there is nothing to stop", async () => {
    await expect(createBackend(enginePlatform(), noShell).cancel()).resolves.toBeUndefined();
  });
});

describe("engines across the boundary", () => {
  const SECOND = { path: "/games/two", type: "fallout2" } as const;

  /** Fetching puts a build in the cache; nothing reaches a game folder until that folder runs it. */
  const fetched = async (platform: ReturnType<typeof enginePlatform>) => {
    const backend = createBackend(platform, { chooseFolder: async () => null });
    await backend.fetchEngine("fallout2-ce", null);
    return backend;
  };

  it("offers the catalog with this machine's build", async () => {
    const backend = createBackend(enginePlatform(), { chooseFolder: async () => null });
    const listed = await backend.machineEngines();
    expect(listed.map((one) => one.id)).toEqual(["fallout2-ce", "fission"]);
    expect(listed[0]!.build?.asset).toBe("fallout2-ce-linux-x64.tar.gz");
  });

  it("says why there is nothing to install where the machine has no build", async () => {
    const platform = enginePlatform({ os: "windows", arch: "arm64" });
    const backend = createBackend(platform, { chooseFolder: async () => null });
    const listed = await backend.machineEngines();
    expect(listed[0]!.build).toBeNull();
    expect(listed[0]!.why).toMatch(/this machine/i);
  });

  it("holds no build before anything has been fetched", async () => {
    const backend = createBackend(enginePlatform(), { chooseFolder: async () => null });
    expect((await backend.machineEngines())[0]!.versions).toEqual([]);
  });

  // The split this surface exists for: fetching is the machine's business and reaches no game folder.
  it("holds a fetched build machine-wide, with nothing deployed anywhere", async () => {
    const platform = enginePlatform({ files: { "/games/one/fallout2.exe": "", "/games/two/fallout2.exe": "" } });
    const backend = await fetched(platform);

    expect((await backend.machineEngines())[0]!.versions).toHaveLength(1);
    expect(await backend.deployedEngines(install)).toEqual([]);
    expect(await backend.deployedEngines(SECOND)).toEqual([]);
  });

  it("launches the engine's program rather than the game's", async () => {
    const platform = enginePlatform();
    const backend = await fetched(platform);
    await backend.launch(install, null, "fallout2-ce", null);
    expect(platform.launched.at(-1)?.program).toBe("./fallout2-ce");
  });

  it("deploys on the first run in a folder, without asking the network anything", async () => {
    const platform = enginePlatform({ files: { "/games/one/fallout2.exe": "", "/games/two/fallout2.exe": "" } });
    const backend = await fetched(platform);

    // The requests the release took are already spent; another would be this path asking the network.
    platform.net.fetchText = async () => Promise.reject(new Error("the first run asked the network"));
    platform.net.download = async () => Promise.reject(new Error("the first run downloaded again"));

    await backend.launch(SECOND, null, "fallout2-ce", null);
    expect(platform.launched.at(-1)?.program).toBe("./fallout2-ce");
    expect(platform.launched.at(-1)?.options?.cwd).toBe("/games/two");
    // Deployed for real and recorded, so the next run is a plain launch.
    expect(await platform.fs.stat("/games/two/fallout2-ce")).not.toBeNull();
    expect((await backend.deployedEngines(SECOND))[0]?.release).toBe("continious");
  });

  it("refuses rather than launching when the machine holds no build", async () => {
    const platform = enginePlatform();
    const backend = createBackend(platform, { chooseFolder: async () => null });
    await expect(backend.launch(install, null, "fallout2-ce", null)).rejects.toThrow(/no copy/i);
    expect(platform.launched).toEqual([]);
  });

  it("drops a build from the cache without touching the folder running it", async () => {
    const platform = enginePlatform();
    const backend = await fetched(platform);
    await backend.launch(install, null, "fallout2-ce", null);
    const held = (await backend.machineEngines())[0]!.versions[0]!;

    await backend.forgetEngine("fallout2-ce", held.published);

    expect((await backend.machineEngines())[0]!.versions).toEqual([]);
    expect(await platform.fs.stat("/games/one/fallout2-ce"), "the folder keeps what it runs").not.toBeNull();
  });

  it("launches the game itself when no engine is named", async () => {
    const platform = enginePlatform();
    const backend = createBackend(platform, { chooseFolder: async () => null });
    await backend.launch(install, null, null, null);
    expect(platform.launched.at(-1)?.program).toBe("wine");
  });
});

describe("the feeds, against the installs asked about", () => {
  /** No responses at all, so every feed refuses - what an offline machine does, counted by request. */
  const offline = () => new MemoryPlatform({ os: "linux", arch: "x64", config: "cfg", cache: "cache" });

  it("reads them once for any number of installs, since a release is published for all of them", async () => {
    const platform = offline();
    const backend = createBackend(platform, noShell);
    await backend.publishedMods();
    const afterFirst = platform.fetched.length;
    expect(afterFirst, "the read happened at all").toBeGreaterThan(0);

    await backend.modInstallState(install);
    await backend.modInstallState({ path: "/games/two", type: "fallout2" });
    await backend.modInstallState(install);

    // The whole point of the split: where an install stands is read from its folder, not from the network.
    expect(platform.fetched).toHaveLength(afterFirst);
  });

  it("asks again when the held answer is a refusal, so a machine that comes back online recovers", async () => {
    const platform = offline();
    const backend = createBackend(platform, noShell);
    const refused = await backend.publishedMods();
    expect(refused.failures.length, "every base feed refused").toBeGreaterThan(0);
    const afterFirst = platform.fetched.length;

    await backend.publishedMods();
    expect(platform.fetched.length, "a refusal is not an answer worth keeping").toBeGreaterThan(afterFirst);
  });
});

describe("the versions a row can be moved to", () => {
  const RPU_RELEASES = "https://api.github.com/repos/BGforgeNet/Fallout2_Restoration_Project/releases?per_page=100";
  const release = (tag: string) => ({
    tag_name: tag,
    assets: [{ name: `rpu_${tag}.zip`, browser_download_url: `https://example.test/${tag}.zip` }],
  });
  const published = () =>
    new MemoryPlatform({
      os: "linux",
      arch: "x64",
      config: "cfg",
      cache: "cache",
      responses: {
        [RPU_RELEASES]: JSON.stringify([release("v2.3.34"), release("v2.3.33"), release("v2.3.32"), release("v30")]),
      },
    });

  it("offers the line's releases, newest first", async () => {
    const backend = createBackend(published(), noShell);
    expect(await backend.modVersions("rpu23")).toEqual(["2.3.34", "2.3.33", "2.3.32", "30"]);
  });

  it("leaves out everything the install already has or has passed", async () => {
    // A base mod's installer has no way back down, so a version below the installed one is not a choice to
    // put on screen - and the counter is what decides that, with `30` below `2.3.32` rather than above it.
    const backend = createBackend(published(), noShell);
    expect(await backend.modVersions("rpu23", "2.3.33")).toEqual(["2.3.34"]);
    expect(await backend.modVersions("rpu23", "30")).toEqual(["2.3.34", "2.3.33", "2.3.32"]);
    expect(await backend.modVersions("rpu23", "2.3.34")).toEqual([]);
  });

  it("refuses a mod no feed follows rather than answering with nothing", async () => {
    const backend = createBackend(published(), noShell);
    await expect(backend.modVersions("not-a-mod")).rejects.toThrow('No known feed carries "not-a-mod"');
  });
});

/** A compile-time check that the list is exactly the interface's keys, not merely a subset of them. */
const _covers: Record<keyof Backend, true> = Object.fromEntries(BACKEND_METHODS.map((name) => [name, true])) as Record<
  keyof Backend,
  true
>;
void _covers;
