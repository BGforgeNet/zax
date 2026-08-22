import { describe, expect, it } from "vitest";
import { MemoryPlatform, type MemoryOptions } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import { parseManifest } from "./manifest.js";
import type { ModRelease } from "./mod-feed.js";
import { componentsFor, planBaseInstall } from "./mod-base.js";

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
refuse:
  - when: { present: [mods/upu.dat] }
    reason: RPU cannot be installed over UPU.
installer:
  windows:
    asset: rpu_v2.4.34.exe
    silent: inno
    components:
      - label: Included
        pick: any
        options:
          - { id: core, label: Core, required: true }
          - { id: worldmap, label: Enhanced world map }
      - label: Walk speed fix
        pick: one
        options:
          - { id: high, label: High FPS }
          - { id: low, label: Low FPS }
  other:
    asset: rpu_v2.4.34.zip
    run: rpu-install.sh
`;

/** The release as the feed would have resolved it on this host: one route, one asset. */
const release = async (route: "windows" | "other" = "other"): Promise<ModRelease> => ({
  manifest: parseManifest(new TextEncoder().encode(MANIFEST)),
  manifestText: MANIFEST,
  manifestFromAsset: true,
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

const basePlatform = (options: MemoryOptions = {}) =>
  new MemoryPlatform({
    files: { [`${GAME}/fallout2.exe`]: "", ...options.files },
    downloads: { [ZIP_URL]: PAYLOAD, [EXE_URL]: "EXE" },
    archives: { [PAYLOAD]: CONTENTS },
    ...options,
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

  it("plans where the host cannot say how much space there is - a check that cannot run is not a failure", async () => {
    // The in-memory platform answers null unless a test says otherwise, which is the browser's answer too.
    const plan = await planBaseInstall(basePlatform(), install, await release());
    expect(plan.free).toBeUndefined();
  });

  it("refuses a release whose installer this platform does not have", async () => {
    const { installer: _resolved, ...nothing } = await release();
    await expect(planBaseInstall(basePlatform(), install, nothing)).rejects.toThrow(/no installer for this system/);
  });

  it("keeps a verified download rather than paying for it twice", async () => {
    const platform = basePlatform();
    await planBaseInstall(platform, install, await release());
    await planBaseInstall(platform, install, await release());
    expect(platform.downloaded).toHaveLength(1);
  });
});

describe("the components an installer is given", () => {
  const manifest = parseManifest(new TextEncoder().encode(MANIFEST));

  it("always includes the required ones, in the order the manifest declares them", () => {
    expect(componentsFor(manifest, ["low"]).map((one) => one.id)).toEqual(["core", "low"]);
    // Inno's own switch deselects everything it does not name, so "required" is a thing to pass, not to skip.
    expect(componentsFor(manifest, []).map((one) => one.id)).toEqual(["core"]);
  });

  it("does not repeat a required component the user also picked", () => {
    expect(componentsFor(manifest, ["core", "worldmap"]).map((one) => one.id)).toEqual(["core", "worldmap"]);
  });

  it("refuses a selection the installer could not carry out", () => {
    expect(() => componentsFor(manifest, ["high", "low"])).toThrow(/Only one Walk speed fix/);
    expect(() => componentsFor(manifest, ["nonesuch"])).toThrow(/does not offer a component/);
  });

  it("carries the selection into the plan, required components and all", async () => {
    const plan = await planBaseInstall(basePlatform({ os: "windows" }), install, await release("windows"), [
      "worldmap",
    ]);
    expect(plan.components).toEqual(["core", "worldmap"]);
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
