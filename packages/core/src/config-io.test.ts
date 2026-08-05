import { describe, expect, it } from "vitest";
import { MemoryPlatform } from "@zax/platform/memory";
import { loadConfigFiles, saveConfigFiles } from "./config-io.js";

const GAME = "/games/one";
const CFG = "[sound]\r\nmusic=1\r\nmaster_volume=32767\r\n";
const INI = "[MAIN]\r\nSCR_WIDTH=640\r\n";
const AT = new Date(2026, 7, 5, 18, 30, 0);
const BACKUP = "/home/t/.cache/zax/backup/2026-08-05_18-30-00";

function game(files: Record<string, string> = {}) {
  return new MemoryPlatform({
    home: "/home/t",
    files: { [`${GAME}/fallout2.cfg`]: CFG, [`${GAME}/f2_res.ini`]: INI, ...files },
  });
}

describe("loading config files", () => {
  it("reads what is there and reports what is not", async () => {
    const found = await loadConfigFiles(game(), GAME, ["fallout2.cfg", "f2_res.ini", "ddraw.ini"]);
    expect(found["fallout2.cfg"]).toBe(CFG);
    expect(found["ddraw.ini"]).toBeUndefined();
  });

  it("reads bytes above the ASCII range unchanged, which a localized install carries", async () => {
    const high = "[system]\r\nlanguage=fran\xe7ais\r\n";
    const found = await loadConfigFiles(game({ [`${GAME}/fallout2.cfg`]: high }), GAME, ["fallout2.cfg"]);
    expect(found["fallout2.cfg"]).toBe(high);
  });
});

describe("saving config files", () => {
  it("rewrites only the keys that changed, leaving every other line alone", async () => {
    const platform = game();
    const outcome = await saveConfigFiles(
      platform,
      {
        installPath: GAME,
        original: { "fallout2.cfg": CFG },
        changes: [{ file: "fallout2.cfg", section: "sound", key: "music", value: "0" }],
      },
      AT,
    );

    expect(outcome).toEqual({ ok: true, files: ["fallout2.cfg"], backup: BACKUP });
    expect(platform.textAt(`${GAME}/fallout2.cfg`)).toBe("[sound]\r\nmusic=0\r\nmaster_volume=32767\r\n");
  });

  it("touches no file it has no change for", async () => {
    const platform = game();
    await saveConfigFiles(
      platform,
      {
        installPath: GAME,
        original: { "fallout2.cfg": CFG, "f2_res.ini": INI },
        changes: [{ file: "fallout2.cfg", section: "sound", key: "music", value: "0" }],
      },
      AT,
    );
    expect(platform.textAt(`${GAME}/f2_res.ini`)).toBe(INI);
    expect(platform.textAt(`${BACKUP}/f2_res.ini`)).toBeUndefined();
  });

  it("copies each file it is about to write to the backup directory first", async () => {
    const platform = game();
    await saveConfigFiles(
      platform,
      {
        installPath: GAME,
        original: { "fallout2.cfg": CFG },
        changes: [{ file: "fallout2.cfg", section: "sound", key: "music", value: "0" }],
      },
      AT,
    );
    expect(platform.textAt(`${BACKUP}/fallout2.cfg`)).toBe(CFG);
  });

  it("refuses and writes nothing when a file changed on disk since it was read", async () => {
    const platform = game();
    const outcome = await saveConfigFiles(
      platform,
      {
        installPath: GAME,
        original: { "fallout2.cfg": "[sound]\r\nmusic=1\r\n" },
        changes: [{ file: "fallout2.cfg", section: "sound", key: "music", value: "0" }],
      },
      AT,
    );

    expect(outcome).toEqual({ ok: false, changed: ["fallout2.cfg"] });
    expect(platform.textAt(`${GAME}/fallout2.cfg`)).toBe(CFG);
    expect(platform.textAt(`${BACKUP}/fallout2.cfg`)).toBeUndefined();
  });

  it("writes nothing at all when one of several files changed, rather than half the intention", async () => {
    const platform = game();
    const outcome = await saveConfigFiles(
      platform,
      {
        installPath: GAME,
        original: { "fallout2.cfg": CFG, "f2_res.ini": "[MAIN]\r\n" },
        changes: [
          { file: "fallout2.cfg", section: "sound", key: "music", value: "0" },
          { file: "f2_res.ini", section: "MAIN", key: "SCR_WIDTH", value: "1024" },
        ],
      },
      AT,
    );

    expect(outcome).toEqual({ ok: false, changed: ["f2_res.ini"] });
    expect(platform.textAt(`${GAME}/fallout2.cfg`)).toBe(CFG);
  });

  it("creates a file the install does not have, which is how a key gets its first value", async () => {
    const platform = game();
    const outcome = await saveConfigFiles(
      platform,
      {
        installPath: GAME,
        original: { "ddraw.ini": undefined },
        changes: [{ file: "ddraw.ini", section: "Debugging", key: "Init", value: "1" }],
      },
      AT,
    );

    expect(outcome.ok).toBe(true);
    expect(platform.textAt(`${GAME}/ddraw.ini`)).toBe("[Debugging]\nInit=1\n");
  });

  it("does nothing and reports no backup when there is nothing to change", async () => {
    const platform = game();
    expect(await saveConfigFiles(platform, { installPath: GAME, original: {}, changes: [] }, AT)).toEqual({
      ok: true,
      files: [],
      backup: null,
    });
    expect(platform.allFiles()).toEqual([`${GAME}/f2_res.ini`, `${GAME}/fallout2.cfg`]);
  });
});
