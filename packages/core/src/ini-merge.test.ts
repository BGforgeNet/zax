import { describe, expect, it } from "vitest";
import { IniDocument } from "./ini.js";
import { mergeIni } from "./ini-merge.js";

const doc = (text: string) => IniDocument.parse(text);
const merge = (theirs: string, mine: string, base: string | null) =>
  mergeIni(doc(theirs), doc(mine), base === null ? null : doc(base));

describe("merging across a version change", () => {
  it("takes the new default where the user never chose one", () => {
    // The whole point of knowing the base: a two-way overlay pins the old default forever.
    const { document, conflicts } = merge("[Main]\nSpeed=5\n", "[Main]\nSpeed=1\n", "[Main]\nSpeed=1\n");
    expect(document.get("Main", "Speed")).toBe("5");
    expect(conflicts).toEqual([]);
  });

  it("keeps the user's setting where the release did not move", () => {
    const { document, conflicts } = merge("[Main]\nSpeed=1\n", "[Main]\nSpeed=9\n", "[Main]\nSpeed=1\n");
    expect(document.get("Main", "Speed")).toBe("9");
    expect(conflicts).toEqual([]);
  });

  it("keeps the user's setting when both moved, and reports it", () => {
    const { document, conflicts } = merge("[Main]\nSpeed=5\n", "[Main]\nSpeed=9\n", "[Main]\nSpeed=1\n");
    expect(document.get("Main", "Speed")).toBe("9");
    expect(conflicts).toEqual([{ section: "Main", key: "Speed", mine: "9", theirs: "5" }]);
  });

  it("drops a retired key the user had left alone", () => {
    const { document, removed } = merge("[Main]\nSpeed=1\n", "[Main]\nSpeed=1\nOld=2\n", "[Main]\nSpeed=1\nOld=2\n");
    expect(document.get("Main", "Old")).toBeUndefined();
    expect(removed).toEqual([{ section: "Main", key: "Old" }]);
  });

  it("keeps a retired key the user had changed", () => {
    const { document, removed } = merge("[Main]\nSpeed=1\n", "[Main]\nSpeed=1\nOld=7\n", "[Main]\nSpeed=1\nOld=2\n");
    expect(document.get("Main", "Old"), "a value someone chose is not ours to discard").toBe("7");
    expect(removed).toEqual([]);
  });

  it("carries the user's own additions without calling them conflicts", () => {
    const { document, conflicts } = merge("[Main]\nSpeed=1\n", "[Main]\nSpeed=1\nMine=1\n", "[Main]\nSpeed=1\n");
    expect(document.get("Main", "Mine")).toBe("1");
    expect(conflicts).toEqual([]);
  });

  it("brings in keys the release added", () => {
    const { document } = merge("[Main]\nSpeed=1\nNew=3\n", "[Main]\nSpeed=1\n", "[Main]\nSpeed=1\n");
    expect(document.get("Main", "New")).toBe("3");
  });

  it("keeps the release's comments, which are its documentation", () => {
    const theirs = "[Main]\n; how fast the game runs\nSpeed=5\n";
    const { document } = merge(theirs, "[Main]\nSpeed=9\n", "[Main]\nSpeed=1\n");
    const text = new TextDecoder().decode(document.toBytes());
    expect(text).toContain("; how fast the game runs");
    expect(text).toContain("Speed=9");
  });

  it("falls back to the user's values throughout when there is no base", () => {
    // An install whose previous version was never recorded. Every value wins, as before this existed.
    const { document, conflicts, removed } = merge("[Main]\nSpeed=5\n", "[Main]\nSpeed=9\nOld=7\n", null);
    expect(document.get("Main", "Speed")).toBe("9");
    expect(document.get("Main", "Old")).toBe("7");
    expect(conflicts).toEqual([]);
    expect(removed).toEqual([]);
  });
});
