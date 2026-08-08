import { describe, expect, it } from "vitest";
import { validate } from "./validate.js";
import type { SettingDef } from "./catalog.js";

const def = (kind: SettingDef["kind"]): SettingDef => ({
  id: "x",
  file: "ddraw.ini",
  section: "Graphics",
  key: "GraphicsWidth",
  kind,
  label: "Graphics width",
});

describe("numeric sanitization", () => {
  const width = def({ type: "int", min: 640, max: 3840, unit: "px", sentinels: { "0": "Native" } });

  it("rejects a value below the real floor", () => {
    // The reported defect: the previous bounds were a spinner range, so a graphics width of 1 was accepted.
    const result = validate(width, "1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("640");
  });

  it("accepts a named sentinel that sits outside the range", () => {
    expect(validate(width, "0").ok).toBe(true);
  });

  it("accepts a real resolution and rejects one above the ceiling", () => {
    expect(validate(width, "1920").ok).toBe(true);
    expect(validate(width, "7680").ok).toBe(false);
  });

  it("rejects non-numbers and fractional integers", () => {
    expect(validate(width, "wide").ok).toBe(false);
    expect(validate(width, "1920.5").ok).toBe(false);
  });

  it("treats an unset value as acceptable rather than invalid", () => {
    expect(validate(width, undefined).ok).toBe(true);
    expect(validate(width, "").ok).toBe(true);
  });
});

describe("choice and scale", () => {
  it("rejects a value outside the declared options", () => {
    const mode = def({
      type: "choice",
      options: [
        { value: "0", label: "Off" },
        { value: "4", label: "DX9" },
      ],
    });
    expect(validate(mode, "4").ok).toBe(true);
    expect(validate(mode, "9").ok).toBe(false);
  });

  it("bounds a scale by the engine maximum", () => {
    const volume = def({ type: "scale", max: 32767 });
    expect(validate(volume, "22281").ok).toBe(true);
    expect(validate(volume, "40000").ok).toBe(false);
    expect(validate(volume, "-1").ok).toBe(false);
  });
});
