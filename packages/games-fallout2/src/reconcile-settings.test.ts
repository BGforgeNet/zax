import { describe, expect, it } from "vitest";
import type { ConfigFileContents } from "@zax/core";
import { SETTINGS } from "./catalog.js";
import { addressOf, reconcileSettings } from "./reconcile-settings.js";

/** The link under test: sfall's own key, fallout2-ce's under another name, and Fission's under a third. */
const BARTER = "sfall.Interface.ExpandBarter";
const SFALL = "ddraw.ini|Interface|ExpandBarter";
const CE = "fallout2.cfg|ui|expand_barter_window";
const FISSION = "fission.cfg|enhancements|EnhancedBarter";

const linked = SETTINGS.filter((one) => one.id === BARTER);

/** An install where both engines have written their settings, each holding the value given. */
const install = (sfall: string | null, ce: string | null, fission: string | null): ConfigFileContents => ({
  "ddraw.ini": sfall === null ? "" : `[Interface]\r\nExpandBarter=${sfall}\r\n`,
  // The [ui] section is what says fallout2-ce has run, so it is here whether or not the key is.
  "fallout2.cfg": `[ui]\r\n${ce === null ? "" : `expand_barter_window=${ce}\r\n`}`,
  "fission.cfg": fission === null ? "" : `[enhancements]\r\nEnhancedBarter=${fission}\r\n`,
});

describe("settling a linked setting", () => {
  it("has nothing to do while every address agrees", () => {
    expect(reconcileSettings(linked, install("1", "1", "1"), {})).toEqual([]);
  });

  it("carries across the one address that moved since ZAX wrote", () => {
    // The user turned it on inside the engine's own preferences screen; the base is what says so.
    const base = { [SFALL]: "0", [CE]: "0", [FISSION]: "0" };
    expect(reconcileSettings(linked, install("0", "1", "0"), base)).toEqual([
      {
        id: BARTER,
        at: expect.arrayContaining([expect.objectContaining({ value: "1" })]),
        settle: { target: expect.objectContaining({ file: "fallout2.cfg" }), value: "1" },
      },
    ]);
  });

  it("asks rather than choosing when two of them moved", () => {
    const base = { [SFALL]: "0", [CE]: "0", [FISSION]: "0" };
    const [found] = reconcileSettings(linked, install("0", "1", "2"), base);
    expect(found?.settle, "a value was picked without asking").toBeUndefined();
    expect(found?.choose?.map((one) => one.value)).toEqual(["1", "2"]);
  });

  it("settles two that moved to the same value, which is agreement rather than a question", () => {
    const base = { [SFALL]: "0", [CE]: "0", [FISSION]: "0" };
    const [found] = reconcileSettings(linked, install("0", "1", "1"), base);
    expect(found?.choose).toBeUndefined();
    expect(found?.settle?.value).toBe("1");
  });

  it("asks nothing about a disagreement every address has a base for, which is one already accepted", () => {
    // Reverting the carry moved each base to what its address then held. Nothing has moved since, so there
    // is nothing to do - and doing it anyway is what made the banner come back on every switch of game.
    const base = { [SFALL]: "0", [CE]: "1", [FISSION]: "0" };
    const [found] = reconcileSettings(linked, install("0", "1", "0"), base);
    expect(found?.settle, "nothing to carry").toBeUndefined();
    expect(found?.choose, "and nothing to ask").toBeUndefined();
  });

  it("reports that accepted disagreement all the same, since the addresses still differ", () => {
    // The interface reads this to know an edit to the setting has somewhere to go: the value it shows comes
    // from one address, and the others still hold something else.
    const base = { [SFALL]: "0", [CE]: "1", [FISSION]: "0" };
    expect(reconcileSettings(linked, install("0", "1", "0"), base).map((one) => one.id)).toEqual([BARTER]);
  });

  it("carries across a later change inside an engine, measured from the accepted base", () => {
    const base = { [SFALL]: "0", [CE]: "1", [FISSION]: "0" };
    const [found] = reconcileSettings(linked, install("0", "2", "0"), base);
    expect(found?.settle).toEqual({ target: expect.objectContaining({ file: "fallout2.cfg" }), value: "2" });
  });

  it("still prefers the setting's own address where one address has no base at all", () => {
    // An engine installed after the disagreement was accepted writes its own defaults and has no base. The
    // rest do, so this is not an accepted disagreement - it is a new engine to carry the known value to.
    const base = { [SFALL]: "1", [CE]: "1" };
    const [found] = reconcileSettings(linked, install("1", "1", "0"), base);
    expect(found?.settle).toEqual({ target: expect.objectContaining({ file: "ddraw.ini" }), value: "1" });
  });

  it("reports every address weighed, which is what accepting the disagreement records", () => {
    const [found] = reconcileSettings(linked, install("1", "0", "0"), {});
    expect(found?.at.map((one) => [one.target.file, one.value])).toEqual([
      ["ddraw.ini", "1"],
      ["fallout2.cfg", "0"],
      ["fission.cfg", "0"],
    ]);
  });

  it("takes the setting's own address the first time, with no base to go on", () => {
    // ddraw.ini holds only what a person put there; an engine writes a value for every key on its first run,
    // so with nothing recorded the engine's side is the one more likely to be a default nobody chose.
    const [found] = reconcileSettings(linked, install("1", "0", "0"), {});
    expect(found?.settle).toEqual({ target: expect.objectContaining({ file: "ddraw.ini" }), value: "1" });
  });

  it("leaves an address alone while its engine has not written its settings", () => {
    // No [ui] section, so fallout2-ce has never run; its key takes no part however the files read.
    const contents: ConfigFileContents = {
      "ddraw.ini": "[Interface]\r\nExpandBarter=1\r\n",
      "fallout2.cfg": "[preferences]\r\nrunning=0\r\n",
    };
    expect(reconcileSettings(linked, contents, {})).toEqual([]);
  });

  it("treats a key a file does not carry as no value rather than as a disagreement", () => {
    // An absent key means that component's own default. Filling it in from a partner would change what the
    // component does, on a load the user only meant as a load.
    expect(reconcileSettings(linked, install(null, "1", null), {})).toEqual([]);
    expect(reconcileSettings(linked, install("0", null, "0"), {})).toEqual([]);
  });

  it("leaves settings only one engine carries out of it entirely", () => {
    const alone = SETTINGS.filter((one) => one.id === "game.preferences.running");
    expect(reconcileSettings(alone, install("1", "0", "0"), {})).toEqual([]);
  });
});

describe("how a base is addressed", () => {
  it("spells an address the way the record keys it", () => {
    expect(addressOf({ file: "ddraw.ini", section: "Interface", key: "ExpandBarter" })).toBe(SFALL);
  });

  it("gives every catalog address a key of its own", () => {
    // The record is keyed by address alone, so two settings sharing one would overwrite each other's base.
    const all = SETTINGS.flatMap((one) => one.targets.map(addressOf));
    expect(new Set(all).size).toBe(all.length);
  });
});
