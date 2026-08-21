import { describe, expect, it } from "vitest";
import { KEY_BY_SCANCODE, SCANCODE_BY_DOM_CODE, parseScancode } from "./catalog.js";

describe("the scancode table", () => {
  it("names the keys sfall's own settings ship bound to", () => {
    // Modifiers, function keys and the arrow block were all absent once, so a file holding one of them
    // rendered as a bare number that the capture control could not put back.
    expect(KEY_BY_SCANCODE["42"]).toBe("Left Shift");
    expect(KEY_BY_SCANCODE["63"]).toBe("F5");
    expect(KEY_BY_SCANCODE["199"]).toBe("Home");
    expect(KEY_BY_SCANCODE["11"]).toBe("0");
  });

  it("gives every key its own name", () => {
    const names = Object.values(KEY_BY_SCANCODE);
    expect(new Set(names).size).toBe(names.length);
  });

  it("reads a binding sfall wrote in hex", () => {
    expect(KEY_BY_SCANCODE[parseScancode("0x2A")]).toBe("Left Shift");
  });
});

describe("capturing a keypress", () => {
  it("writes the scancode of the physical key", () => {
    expect(SCANCODE_BY_DOM_CODE["ShiftLeft"]).toBe("42");
    expect(SCANCODE_BY_DOM_CODE["Numpad7"]).toBe("71");
    expect(SCANCODE_BY_DOM_CODE["ArrowUp"]).toBe("200");
  });

  it("leaves nothing bindable to a scancode with no name", () => {
    // Guarded against an empty table, which would pass the loop below without asserting anything.
    expect(Object.keys(SCANCODE_BY_DOM_CODE).length).toBeGreaterThan(Object.keys(KEY_BY_SCANCODE).length / 2);
    for (const [domCode, scancode] of Object.entries(SCANCODE_BY_DOM_CODE)) {
      expect(KEY_BY_SCANCODE[scancode], domCode).toBeDefined();
    }
  });

  it("has no browser key standing for two scancodes", () => {
    const codes = Object.keys(SCANCODE_BY_DOM_CODE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
