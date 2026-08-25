import { describe, expect, it } from "vitest";
import { describeValueTest, matchesValueTest, valueSatisfying } from "./catalog.js";
import type { SettingDef } from "./catalog.js";

const def = (kind: SettingDef["kind"], label = "Controller"): SettingDef => ({
  id: "x",
  targets: [{ file: "ddraw.ini", section: "Graphics", key: "Mode" }],
  kind,
  label,
});

const mode = def({
  type: "choice",
  options: [
    { value: "0", label: "8 bit fullscreen" },
    { value: "4", label: "DX9 fullscreen" },
    { value: "5", label: "DX9 windowed" },
  ],
});
const idle = def({ type: "int", min: 0, sentinels: { "-1": "Disabled" } }, "CPU idle");
const binding = def({ type: "key" }, "Item fast move key");

describe("is", () => {
  it("matches only a listed value", () => {
    expect(matchesValueTest(mode, "4", { is: ["4", "5"] })).toBe(true);
    expect(matchesValueTest(mode, "0", { is: ["4", "5"] })).toBe(false);
  });

  it("names the listed values by their labels, not their raw numbers", () => {
    expect(describeValueTest(mode, { is: ["4", "5"] })).toBe("DX9 fullscreen or DX9 windowed");
  });
});

describe("isNot", () => {
  it("matches anything outside the excluded set", () => {
    // The case it exists for: "idling is on" is every millisecond count, which cannot be listed.
    expect(matchesValueTest(idle, "0", { isNot: ["-1"] })).toBe(true);
    expect(matchesValueTest(idle, "250", { isNot: ["-1"] })).toBe(true);
    expect(matchesValueTest(idle, "-1", { isNot: ["-1"] })).toBe(false);
  });

  it("treats an unset or blank value as no value at all, not as some other value", () => {
    expect(matchesValueTest(idle, undefined, { isNot: ["-1"] })).toBe(false);
    expect(matchesValueTest(idle, "", { isNot: ["-1"] })).toBe(false);
    expect(matchesValueTest(idle, "   ", { isNot: ["-1"] })).toBe(false);
  });

  it("folds a key binding's hex form onto its decimal one", () => {
    // sfall writes some bindings in hex, so an unbound key reads 0x0 in one file and 0 in the next; without
    // the fold the hex spelling counts as bound and the gate opens on a key nobody set.
    expect(matchesValueTest(binding, "0", { isNot: ["0"] })).toBe(false);
    expect(matchesValueTest(binding, "0x0", { isNot: ["0"] })).toBe(false);
    expect(matchesValueTest(binding, "0x00", { isNot: ["0"] })).toBe(false);
    expect(matchesValueTest(binding, "30", { isNot: ["0"] })).toBe(true);
  });

  it("phrases a key binding as a key rather than as a list of exclusions", () => {
    expect(describeValueTest(binding, { isNot: ["0"] })).toBe("a key");
    expect(describeValueTest(idle, { isNot: ["-1"] })).toBe("anything but Disabled");
  });
});

describe("valueSatisfying", () => {
  it("writes the first value a listed test names", () => {
    // The graphics gates accept three modes; the order is the catalog author's, so the first is the answer.
    expect(valueSatisfying(mode, { is: ["4", "5"] })).toBe("4");
  });

  it("inverts an excluded value where the kind's values can be listed", () => {
    expect(valueSatisfying(mode, { isNot: ["0", "4"] })).toBe("5");
  });

  it("offers nothing where the test leaves an open range", () => {
    // "a key is bound" is every key but none - choosing one would rebind the keyboard on the user's behalf.
    expect(valueSatisfying(binding, { isNot: ["0"] })).toBeUndefined();
    expect(valueSatisfying(idle, { isNot: ["-1"] })).toBeUndefined();
  });
});
