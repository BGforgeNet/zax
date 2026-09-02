import { describe, expect, it } from "vitest";
import { ENGINES } from "./engines.js";
import { FISSION_CAUTION, FISSION_ID, fissionMounts } from "./fission.js";

describe("what Fission would mount", () => {
  it("takes a dat under the prefix its scan requires", () => {
    expect(fissionMounts("mod_rpu.dat")).toBe(true);
  });

  /*
    The two shapes sfall loads and Fission does not, which is the whole point of the rule: a folder is a legal
    entry in the order file, and a dat may be named anything the author chose.
  */
  it("refuses a folder, whatever it is called", () => {
    expect(fissionMounts("mod_rpu")).toBe(false);
    expect(fissionMounts("rpu")).toBe(false);
  });

  it("refuses a dat that does not carry the prefix", () => {
    expect(fissionMounts("rpu.dat")).toBe(false);
    expect(fissionMounts("InventoryFilter.dat")).toBe(false);
    // The prefix has to start the name rather than appear in it.
    expect(fissionMounts("no_mod_rpu.dat")).toBe(false);
  });

  it("refuses a dat below the top level, which the folder scan never reaches", () => {
    expect(fissionMounts("patches/mod_rpu.dat")).toBe(false);
    expect(fissionMounts("patches\\mod_rpu.dat")).toBe(false);
  });

  /* The mods folder is the user's, and on Windows the case of what they put there is theirs too. */
  it("reads the name without regard to case", () => {
    expect(fissionMounts("MOD_RPU.DAT")).toBe(true);
    expect(fissionMounts("Mod_Rpu.Dat")).toBe(true);
  });

  it("refuses the prefix with nothing after it", () => {
    expect(fissionMounts("mod_.dat")).toBe(false);
  });
});

describe("the caution", () => {
  /*
    The three surfaces that show it read it off the engine listing, which reads it off the catalog. An entry
    that lost the field would take the warning out of all three at once and break no other test.
  */
  it("is what the catalog gives the engine it is about", () => {
    const fission = ENGINES.find((engine) => engine.id === FISSION_ID);
    expect(fission?.caution).toBe(FISSION_CAUTION);
  });

  it("is declared for that engine alone, so it is not said of engines it is untrue of", () => {
    const carrying = ENGINES.filter((engine) => engine.caution !== undefined).map((engine) => engine.id);
    expect(carrying).toEqual([FISSION_ID]);
  });
});
