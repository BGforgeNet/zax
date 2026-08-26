import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { IniDocument, loadConfigFiles, saveConfigFiles } from "@zax/core";
import { SETTINGS } from "./catalog.js";
import { contentConfigPath, engineConfigPaths, hasMintedSettings, liveTargets } from "./engine-config.js";
import { ENGINES } from "./engines.js";

const GAME = "/games/fallout2";
const CE = ENGINES.find((one) => one.id === "fallout2-ce")!;
const FISSION = ENGINES.find((one) => one.id === "fission")!;

/** What a stock install's config file holds of the two sections these tests care about. */
const vanilla = (patches = "data") => `[system]\r\nmaster_patches=${patches}\r\n[preferences]\r\nrunning=0\r\n`;

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (raw: Uint8Array) => new TextDecoder("latin1").decode(raw);

describe("the content config's path", () => {
  it("puts it under the directory master_patches names", () => {
    // fallout2-ce composes exactly this: "%s\\%s" over master_patches and config\game#patch.cfg.
    expect(contentConfigPath("data")).toBe("data/config/game#patch.cfg");
  });

  it("reads the separator the game's own config file uses", () => {
    expect(contentConfigPath("data\\")).toBe("data/config/game#patch.cfg");
    expect(contentConfigPath("mods\\hires")).toBe("mods/hires/config/game#patch.cfg");
  });

  it("names none where master_patches names none", () => {
    // The engine abandons the import outright rather than falling back to a directory of its own.
    expect(contentConfigPath("")).toBeNull();
    expect(contentConfigPath("   ")).toBeNull();
    expect(contentConfigPath(undefined)).toBeNull();
  });
});

describe("the engines' config files in an install", () => {
  it("resolves the content config against the directory the install actually has", async () => {
    const platform = new MemoryPlatform({ dirs: [`${GAME}/data`] });
    expect(await engineConfigPaths(platform, GAME, vanilla())).toEqual({
      "fission.cfg": "fission.cfg",
      "game#patch.cfg": "data/config/game#patch.cfg",
    });
  });

  it("leaves it out where master_patches points at nothing", async () => {
    // fallout2-ce checks the same thing and skips its import; writing there would create a game directory the
    // game itself treats as absent, and Fission's own file is unaffected either way.
    const platform = new MemoryPlatform({ dirs: [`${GAME}/data`] });
    expect(await engineConfigPaths(platform, GAME, vanilla("elsewhere"))).toEqual({ "fission.cfg": "fission.cfg" });
  });

  it("leaves it out where the install has no config file to read it from", async () => {
    const platform = new MemoryPlatform();
    expect(await engineConfigPaths(platform, GAME, undefined)).toEqual({ "fission.cfg": "fission.cfg" });
  });
});

describe("whether an engine has written its settings", () => {
  it("reads a vanilla config file as fallout2-ce not having run", async () => {
    // Every install has this file, so its presence says nothing; the sections the engine adds are the mark.
    expect(hasMintedSettings(CE, { "fallout2.cfg": vanilla() })).toBe(false);
  });

  it("reads the section fallout2-ce writes on its first run", () => {
    expect(hasMintedSettings(CE, { "fallout2.cfg": `${vanilla()}[ui]\r\nexpand_barter_window=0\r\n` })).toBe(true);
    // However the file spells it - ini sections are matched case-insensitively everywhere else too.
    expect(hasMintedSettings(CE, { "fallout2.cfg": `${vanilla()}[UI]\r\nextend_ap_bar=0\r\n` })).toBe(true);
  });

  it("reads Fission's own file, which nothing else in an install creates", () => {
    expect(hasMintedSettings(FISSION, {})).toBe(false);
    expect(hasMintedSettings(FISSION, { "fission.cfg": "" })).toBe(true);
  });

  it("says no for an install nothing has been read from yet", () => {
    for (const engine of ENGINES) expect(hasMintedSettings(engine, {}), engine.id).toBe(false);
  });
});

describe("which of a setting's addresses an edit writes", () => {
  const barter = SETTINGS.find((one) => one.id === "sfall.Interface.ExpandBarter")!;
  const files = (contents: Parameters<typeof liveTargets>[1]) => liveTargets(barter, contents).map((t) => t.file);

  it("writes only its own address while both engines are dormant", () => {
    // Not "writes nothing": sfall's own key is nobody's engine and is written as it always was.
    expect(files({ "fallout2.cfg": vanilla() })).toEqual(["ddraw.ini"]);
  });

  it("reaches an engine's address once that engine has written its settings", () => {
    expect(files({ "fallout2.cfg": `${vanilla()}[ui]\r\nextend_ap_bar=0\r\n` })).toEqual(["ddraw.ini", "fallout2.cfg"]);
    expect(files({ "fallout2.cfg": vanilla(), "fission.cfg": "" })).toEqual(["ddraw.ini", "fission.cfg"]);
  });

  it("reaches every live one at once, which is what makes the several names one setting", () => {
    const both = { "fallout2.cfg": `${vanilla()}[ui]\r\nextend_ap_bar=0\r\n`, "fission.cfg": "" };
    expect(files(both)).toEqual(["ddraw.ini", "fallout2.cfg", "fission.cfg"]);
  });

  it("leaves a setting with no engine addresses exactly as it was", () => {
    const running = SETTINGS.find((one) => one.id === "game.preferences.running")!;
    expect(liveTargets(running, {}).map((t) => t.file)).toEqual(["fallout2.cfg"]);
  });
});

describe("reading and writing an engine's files", () => {
  it("writes the content config where the engine reads it, creating the directory it needs", async () => {
    const platform = new MemoryPlatform({ dirs: [`${GAME}/data`] });
    await platform.fs.write(`${GAME}/fallout2.cfg`, bytes(vanilla()));
    const paths = await engineConfigPaths(platform, GAME, vanilla());

    const outcome = await saveConfigFiles(platform, {
      installPath: GAME,
      original: { "game#patch.cfg": undefined },
      changes: [{ file: "game#patch.cfg", section: "combat", key: "damage_formula", value: "5" }],
      paths,
    });

    expect(outcome.ok).toBe(true);
    const written = await platform.fs.read(`${GAME}/data/config/game#patch.cfg`);
    expect(IniDocument.parse(text(written)).get("combat", "damage_formula")).toBe("5");
  });

  it("reads it back under the name settings address it by, not the path it sits at", async () => {
    const platform = new MemoryPlatform({ dirs: [`${GAME}/data`] });
    await platform.fs.write(`${GAME}/fallout2.cfg`, bytes(vanilla()));
    await platform.fs.write(`${GAME}/data/config/game#patch.cfg`, bytes("[combat]\r\ninventory_ap_cost=4\r\n"));
    await platform.fs.write(`${GAME}/fission.cfg`, bytes("[enhancements]\r\nMinimap=1\r\n"));
    const paths = await engineConfigPaths(platform, GAME, vanilla());

    const held = await loadConfigFiles(platform, GAME, Object.keys(paths), paths);

    expect(held["game#patch.cfg"]).toBe("[combat]\r\ninventory_ap_cost=4\r\n");
    expect(held["fission.cfg"]).toBe("[enhancements]\r\nMinimap=1\r\n");
  });

  it("leaves every other line of an engine's file exactly as it was", async () => {
    // The same losslessness the game's own files get: these are the user's files and are hand-edited too.
    const before = "; kept\r\n[combat]\r\ndamage_formula=0\r\n\r\n[explosions]\r\nemit_light=0\r\n";
    const platform = new MemoryPlatform({ dirs: [`${GAME}/data`] });
    await platform.fs.write(`${GAME}/fallout2.cfg`, bytes(vanilla()));
    await platform.fs.write(`${GAME}/data/config/game#patch.cfg`, bytes(before));
    const paths = await engineConfigPaths(platform, GAME, vanilla());

    await saveConfigFiles(platform, {
      installPath: GAME,
      original: { "game#patch.cfg": before },
      changes: [{ file: "game#patch.cfg", section: "combat", key: "damage_formula", value: "5" }],
      paths,
    });

    const after = text(await platform.fs.read(`${GAME}/data/config/game#patch.cfg`));
    const changed = after.split("\r\n").filter((line, at) => line !== before.split("\r\n")[at]);
    expect(changed).toEqual(["damage_formula=5"]);
  });

  // The file whose location is not its own name is where a copy taken aside would land somewhere unintended,
  // so it is the one worth holding to writing nothing but the file it was asked to write.
  it("copies nothing aside for a file whose path is not its name", async () => {
    const platform = new MemoryPlatform({ dirs: [`${GAME}/data`] });
    await platform.fs.write(`${GAME}/fallout2.cfg`, bytes(vanilla()));
    await platform.fs.write(`${GAME}/data/config/game#patch.cfg`, bytes("[combat]\r\ndamage_formula=0\r\n"));
    const paths = await engineConfigPaths(platform, GAME, vanilla());

    const outcome = await saveConfigFiles(platform, {
      installPath: GAME,
      original: { "game#patch.cfg": "[combat]\r\ndamage_formula=0\r\n" },
      changes: [{ file: "game#patch.cfg", section: "combat", key: "damage_formula", value: "5" }],
      paths,
    });

    expect(outcome.ok).toBe(true);
    expect(platform.allFiles()).toEqual([`${GAME}/data/config/game#patch.cfg`, `${GAME}/fallout2.cfg`]);
  });
});
