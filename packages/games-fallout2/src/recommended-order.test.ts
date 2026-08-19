import { describe, expect, it } from "vitest";
import type { Mod } from "./mods.js";
import {
  RPU_ORDER,
  SHARED_ORDER,
  UPU_ORDER,
  againstRecommendation,
  placeFor,
  rankOf,
  recommendationFor,
  recommendedOrder,
} from "./recommended-order.js";

/** An order to test against, the shipped one being a judgement rather than a fixture. */
const ORDER = ["rpu.dat", "big_content", "fo2tweaks.dat"];

const mods = (...names: string[]): Mod[] => names.map((name) => ({ name, enabled: true, kind: "dat" }));
const names = (list: readonly Mod[]) => list.map((mod) => mod.name);

describe("rankOf", () => {
  it("answers with an entry's place, however it is cased", () => {
    expect(rankOf("RPU.DAT", ORDER)).toBe(0);
    expect(rankOf("fo2tweaks.dat", ORDER)).toBe(2);
  });

  it("answers with nothing for an entry the recommendation does not name", () => {
    expect(rankOf("weapon_sounds.dat", ORDER)).toBeNull();
  });
});

describe("recommendedOrder", () => {
  it("puts the mods the recommendation names in its order", () => {
    expect(names(recommendedOrder(mods("fo2tweaks.dat", "big_content", "rpu.dat"), ORDER))).toEqual([
      "rpu.dat",
      "big_content",
      "fo2tweaks.dat",
    ]);
  });

  it("leaves every other entry exactly where it was", () => {
    const held = mods("fo2tweaks.dat", "weapon_sounds.dat", "rpu.dat", "hero_appearance");
    expect(names(recommendedOrder(held, ORDER))).toEqual([
      "rpu.dat",
      "weapon_sounds.dat",
      "fo2tweaks.dat",
      "hero_appearance",
    ]);
  });

  it("changes nothing about a list that already follows it, however often it runs", () => {
    const held = mods("rpu.dat", "weapon_sounds.dat", "fo2tweaks.dat");
    const once = recommendedOrder(held, ORDER);
    expect(names(once)).toEqual(names(held));
    expect(names(recommendedOrder(once, ORDER))).toEqual(names(held));
  });

  it("loads the Restoration Project before the tweaks that override it, on the shipped order", () => {
    const held = mods("fo2tweaks.dat", "rpu.dat");
    expect(names(recommendedOrder(held, RPU_ORDER))).toEqual(["rpu.dat", "fo2tweaks.dat"]);
  });

  it("says nothing about a folder no shipped order names", () => {
    const held = mods("weapon_sounds.dat", "hero_appearance");
    expect(againstRecommendation(held, recommendationFor("fallout2"))).toEqual([]);
  });
});

describe("the shipped orders", () => {
  it("judges each Updated install against its own project, and nothing against the other's", () => {
    expect(recommendationFor("fallout2rpu")).toBe(RPU_ORDER);
    expect(recommendationFor("fallout2upu")).toBe(UPU_ORDER);
    expect(rankOf("upu.dat", recommendationFor("fallout2rpu"))).toBeNull();
    expect(rankOf("rpu.dat", recommendationFor("fallout2upu"))).toBeNull();
  });

  it("gives every other type what both projects agree on, and neither project's own files", () => {
    for (const type of ["fallout2", "fallout2up", "fallout2rp", "fo1in2"] as const) {
      expect(recommendationFor(type)).toBe(SHARED_ORDER);
    }
    expect(SHARED_ORDER).toContain("fo2tweaks.dat");
    expect(SHARED_ORDER).not.toContain("rpu.dat");
    expect(SHARED_ORDER).not.toContain("rpu_czech.dat");
  });

  /*
    The shared order takes RPU's sequence for the entries both name, which is only sound while the two agree
    about them. Read UPU's sequence for the same entries and the two must match; the day one project moves
    one, this is what says so rather than the difference being settled silently in RPU's favour.
  */
  it("is only shared where the two projects place those mods alike", () => {
    const asUpuHasThem = UPU_ORDER.filter((name) => RPU_ORDER.includes(name));
    expect(asUpuHasThem).toEqual([...SHARED_ORDER]);
  });
});

describe("againstRecommendation", () => {
  it("names the entries a sort would move, and only those", () => {
    const held = mods("fo2tweaks.dat", "weapon_sounds.dat", "rpu.dat");
    expect(againstRecommendation(held, ORDER)).toEqual(["fo2tweaks.dat", "rpu.dat"]);
  });

  it("names nothing when the file already follows the recommendation", () => {
    expect(againstRecommendation(mods("rpu.dat", "fo2tweaks.dat"), ORDER)).toEqual([]);
  });
});

describe("placeFor", () => {
  it("lands above the first mod the recommendation loads after it", () => {
    expect(placeFor(mods("rpu.dat", "weapon_sounds.dat", "fo2tweaks.dat"), "big_content", ORDER)).toBe(2);
  });

  it("lands at the end when nothing here loads after it, keeping the place an install used to give it", () => {
    expect(placeFor(mods("rpu.dat", "weapon_sounds.dat"), "fo2tweaks.dat", ORDER)).toBe(2);
  });

  it("does not step over a mod the recommendation says nothing about", () => {
    expect(placeFor(mods("weapon_sounds.dat", "hero_appearance"), "fo2tweaks.dat", ORDER)).toBe(2);
  });

  it("lands at the end for a mod it does not name, which is where installs put one", () => {
    expect(placeFor(mods("rpu.dat", "fo2tweaks.dat"), "weapon_sounds.dat", ORDER)).toBe(2);
  });
});
