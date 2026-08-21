import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { BACKEND_METHODS } from "./backend-methods.js";
import { RELEASES_PAGE, createBackend } from "./backend.js";
import type { Backend } from "./backend.js";

const install = { path: "/games/one", type: "fallout2" as const };

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
    const declared = Object.keys(backend).sort();
    expect([...BACKEND_METHODS].sort()).toEqual(declared);
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

  it("reads the state file through to the resolved install", async () => {
    const { state } = await createBackend(ready(), noShell).loadState();
    expect(state.installs).toEqual([{ path: "/games/one", type: "fallout2" }]);
    expect(state.theme).toBe("dark");
  });

  it("launches through the plan for this machine", async () => {
    const platform = ready();
    await createBackend(platform, noShell).launch({ ...install, wine: { prefix: "/p" } }, "4.5");
    expect(platform.launched).toEqual([
      {
        program: "wine",
        args: ["fallout2.exe"],
        options: { cwd: "/games/one", env: { WINEPREFIX: "/p", WINEDLLOVERRIDES: "ddraw.dll=n,b" } },
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
          assets: [{ name: "zax", browser_download_url: "https://example/zax" }],
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
        write: (path: string, bytes: Uint8Array) => {
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

/** A compile-time check that the list is exactly the interface's keys, not merely a subset of them. */
const _covers: Record<keyof Backend, true> = Object.fromEntries(BACKEND_METHODS.map((name) => [name, true])) as Record<
  keyof Backend,
  true
>;
void _covers;
