import { describe, expect, it } from "vitest";
import { MemoryPlatform, type MemoryOptions } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import { parseManifest } from "./manifest.js";
import type { ModRelease } from "./mod-feed.js";
import { loadRecord } from "./records.js";
import { applyCreateInstall, planCreateInstall } from "./mod-create.js";
import type { ReadyDatTool } from "./dat-tool.js";
import { uninstallMod } from "./mod-install.js";

const GAME = "/game";
const FO1 = "/fallout1";
const TOOL_PATH = "/cache/tools/dat3";
const TOOL: ReadyDatTool = { path: TOOL_PATH, kind: "native" };
const install: Install = { path: GAME, type: "fallout2" };
const ZIP_URL = "https://example.test/Fallout1in2.zip";
const PAYLOAD = "ZIP-FO1IN2";

const sha = async (value: string) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const MANIFEST = `spec: 1
id: fo1in2
name: Fallout et tu
version: "1.16.3771"
game: fallout2
type: base
becomes: fo1in2
archive: Fallout1in2.zip
creates:
  directory: Fallout1in2
inputs:
  - id: fallout1
    label: Your Fallout 1 folder
    holds: master.dat
extract-dat:
  from: fallout1
  list: undat_files.txt
  into: data
`;

const LIST = "ART\\SCENERY\\CSTALAG2.FRM\r\nSOUND\\MUSIC\\01.ACM\r\n";

/** What the payload carries: everything under the one directory it creates, as the real release does. */
const CONTENTS = {
  "Fallout1in2/Fallout2.exe": "EXE",
  "Fallout1in2/ddraw.ini": "[Misc]\nVersionString=FALLOUT ET TU v1.16.3771\n",
  "Fallout1in2/mods/fo1_base/order.txt": "",
  "Fallout1in2/undat_files.txt": LIST,
};

const releaseOf = async (manifest: string): Promise<ModRelease> => ({
  manifest: parseManifest(new TextEncoder().encode(manifest)),
  manifestText: manifest,
  manifestFromAsset: false,
  archive: { name: "Fallout1in2.zip", url: ZIP_URL, digest: `sha256:${await sha(PAYLOAD)}`, size: PAYLOAD.length },
});

const release = () => releaseOf(MANIFEST);

const createPlatform = (options: MemoryOptions = {}) =>
  new MemoryPlatform({
    ...options,
    files: { [`${GAME}/fallout2.exe`]: "", [`${FO1}/MASTER.DAT`]: "DAT1", ...options.files },
    downloads: { [ZIP_URL]: PAYLOAD, ...options.downloads },
    archives: { [PAYLOAD]: CONTENTS, ...options.archives },
    // The extraction tool, answering as dat3 does when everything it was asked for is there.
    runs: { [TOOL_PATH]: { code: 0, output: "2 files" }, ...options.runs },
  });

const inputs = { fallout1: FO1 };

describe("planning an install that creates another", () => {
  it("names what it creates, what it reads, and what both cost", async () => {
    const platform = createPlatform();
    const plan = await planCreateInstall(platform, install, await release(), inputs, TOOL);
    expect(plan).toMatchObject({
      kind: "creates",
      version: "1.16.3771",
      directory: "Fallout1in2",
      asset: "Fallout1in2.zip",
      download: PAYLOAD.length,
      becomes: "fo1in2",
      inputs: { fallout1: FO1 },
    });
    expect(plan.unpacked).toBe(Object.values(CONTENTS).join("").length);
    // Counted out of the list the payload ships rather than guessed: it is how many files this lifts out of
    // the user's own copy of Fallout 1.
    expect(plan.extracts).toBe(2);
    // Planning writes nothing into the game folder.
    expect(await platform.fs.stat(`${GAME}/Fallout1in2`)).toBeNull();
  });

  it("refuses a folder that is not the game it asked for, before anything is downloaded", async () => {
    const platform = createPlatform();
    await expect(
      planCreateInstall(platform, install, await release(), { fallout1: "/elsewhere" }, TOOL),
    ).rejects.toThrow(/master\.dat/);
    expect(platform.downloaded).toEqual([]);
  });

  it("refuses when it was given no answer at all", async () => {
    const platform = createPlatform();
    await expect(planCreateInstall(platform, install, await release(), {}, TOOL)).rejects.toThrow(
      /Your Fallout 1 folder/,
    );
  });

  it("refuses an archive the tool cannot read, saying what it said", async () => {
    const platform = createPlatform({ runs: { [TOOL_PATH]: { code: 1, output: "Error: DAT size mismatch" } } });
    await expect(planCreateInstall(platform, install, await release(), inputs, TOOL)).rejects.toThrow(
      /DAT size mismatch/,
    );
    expect(platform.downloaded).toEqual([]);
  });

  it("refuses a payload that would write outside the directory it creates", async () => {
    const platform = createPlatform({ archives: { [PAYLOAD]: { ...CONTENTS, "mods/sneaky.dat": "DAT" } } });
    await expect(planCreateInstall(platform, install, await release(), inputs, TOOL)).rejects.toThrow(
      /mods\/sneaky\.dat/,
    );
  });

  it("refuses a payload that does not carry the list the manifest names", async () => {
    const short = Object.fromEntries(Object.entries(CONTENTS).filter(([name]) => !name.endsWith("undat_files.txt")));
    const platform = createPlatform({ archives: { [PAYLOAD]: short } });
    await expect(planCreateInstall(platform, install, await release(), inputs, TOOL)).rejects.toThrow(
      /undat_files\.txt/,
    );
  });

  it("refuses where the drive cannot hold what the payload unpacks to", async () => {
    const platform = createPlatform({ freeSpace: PAYLOAD.length + 1 });
    await expect(planCreateInstall(platform, install, await release(), inputs, TOOL)).rejects.toThrow(/unpacks to/);
  });

  it("fingerprints the folder it was pointed at, so a confirmed plan cannot read from another", async () => {
    const platform = createPlatform({ files: { "/other/master.dat": "DAT1" } });
    const first = await planCreateInstall(platform, install, await release(), inputs, TOOL);
    const second = await planCreateInstall(platform, install, await release(), { fallout1: "/other" }, TOOL);
    expect(second.fingerprint).not.toBe(first.fingerprint);
  });
});

describe("performing an install that creates another", () => {
  const finished = async (options: MemoryOptions = {}) => {
    const platform = createPlatform(options);
    const found = await release();
    const plan = await planCreateInstall(platform, install, found, inputs, TOOL);
    const outcome = await applyCreateInstall(platform, install, found, plan, TOOL);
    return { platform, outcome };
  };

  it("unpacks the payload and then the user's own archive into what it created", async () => {
    const { platform, outcome } = await finished();
    expect(outcome.created).toBe(`${GAME}/Fallout1in2`);
    expect(outcome.version).toBe("1.16.3771");
    expect(outcome.extracted).toBe(2);
    expect(await platform.fs.stat(`${GAME}/Fallout1in2/Fallout2.exe`)).not.toBeNull();

    // The gate first, against the list the payload carries, then the extraction into the created install.
    const args = platform.ran.map((one) => one.args);
    expect(args[0]?.slice(0, 2)).toEqual(["l", `${FO1}/MASTER.DAT`]);
    const extraction = args.find((one) => one[0] === "x");
    expect(extraction?.slice(0, 5)).toEqual([
      "x",
      `${FO1}/MASTER.DAT`,
      "--ignore-missing",
      "-o",
      `${GAME}/Fallout1in2/data`,
    ]);
    expect(extraction?.[5]).toContain("undat_files.txt");
  });

  it("records the install against the host, complete, without changing what the host is", async () => {
    const { platform } = await finished();
    const record = await loadRecord(platform, GAME);
    expect(record.mods).toEqual([
      expect.objectContaining({ id: "fo1in2", version: "1.16.3771", type: "base", complete: true }),
    ]);
  });

  /** What the tool prints when `--ignore-missing` let it extract around the named paths. */
  const skipping = (...names: string[]) =>
    `Extracting 2 files...\n\nWarning: files not found:\n${names.map((name) => `  ${name}`).join("\n")}\nDone`;

  it("installs an archive an edition apart, reporting the paths it went without", async () => {
    // Fallout et tu v1.16.3771 asks for files whose 8.3 collision suffix is assigned in archive order, so
    // another edition spells them differently - hundreds of them, which is why no count refuses an install
    // here. The count reported has to lose them, or it names files that never landed.
    const platform = createPlatform();
    const found = await release();
    const plan = await planCreateInstall(platform, install, found, inputs, TOOL);
    const apart = createPlatform({
      runs: { [`${TOOL_PATH} x`]: { code: 0, output: skipping("SOUND/SPEECH/LIEUT/LI3ACF~5.TXT") } },
    });
    const outcome = await applyCreateInstall(apart, install, found, plan, TOOL);
    expect(outcome.skipped).toEqual(["SOUND/SPEECH/LIEUT/LI3ACF~5.TXT"]);
    expect(outcome.extracted).toBe(1);
    expect(await apart.fs.stat(`${GAME}/Fallout1in2/Fallout2.exe`)).not.toBeNull();
  });

  it("leaves the record incomplete when the extraction fails, so a relaunch says so", async () => {
    const platform = createPlatform();
    const found = await release();
    const plan = await planCreateInstall(platform, install, found, inputs, TOOL);
    // Readable, holds the list, and then fails part way through the extraction itself.
    const ran = platform.process.run.bind(platform.process);
    platform.process.run = async (program, args, options) =>
      args[0] === "x" ? { code: 1, output: "Error: stopped part way" } : ran(program, args, options);

    await expect(applyCreateInstall(platform, install, found, plan, TOOL)).rejects.toThrow(/stopped part way/);
    const record = await loadRecord(platform, GAME);
    expect(record.mods[0]).toMatchObject({ id: "fo1in2", complete: false });
  });

  it("keeps the user's settings in the created install across an upgrade", async () => {
    const { platform } = await finished();
    // The user changed something ZAX's own tabs edit, in the install that was created.
    const edited = "[Misc]\nVersionString=FALLOUT ET TU v1.16.3771\nMyOwn=7\n";
    await platform.fs.write(`${GAME}/Fallout1in2/ddraw.ini`, new TextEncoder().encode(edited));

    const upgraded = await releaseOf(MANIFEST.replace('version: "1.16.3771"', 'version: "1.17.3800"'));
    const plan = await planCreateInstall(platform, install, upgraded, inputs, TOOL);
    await applyCreateInstall(platform, install, upgraded, plan, TOOL);

    const after = new TextDecoder().decode(await platform.fs.read(`${GAME}/Fallout1in2/ddraw.ini`));
    expect(after).toContain("MyOwn=7");
  });
});

describe("removing what created an install", () => {
  it("says the folder is the way back, rather than telling the user to reinstall the game", async () => {
    const { platform } = await (async () => {
      const platform = createPlatform();
      const found = await release();
      const plan = await planCreateInstall(platform, install, found, inputs, TOOL);
      await applyCreateInstall(platform, install, found, plan, TOOL);
      return { platform };
    })();
    // The host was never touched, so "start from a fresh copy of the game" - what a delegated base mod's
    // removal says - would be false here.
    await expect(uninstallMod(platform, install, "fo1in2")).rejects.toThrow(/folder to delete by hand/);
    await expect(uninstallMod(platform, install, "fo1in2")).rejects.toThrow(/Fallout1in2/);
  });
});
