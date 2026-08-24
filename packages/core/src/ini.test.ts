import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { IniDocument } from "./ini.js";

/** Generates the shapes real config files contain: comments, odd spacing, duplicate keys, mixed terminators. */
const iniText = fc
  .array(
    fc.oneof(
      fc.constant(""),
      fc.constantFrom("; a comment", "# another", "   ; indented comment"),
      fc.constantFrom("[Main]", "[Speed]", "[ Spaced ]", "[]"),
      fc.constantFrom("Key=1", "Key = 1", "  Key   =   value  ", "Key=", "Dup=a", "Dup=b", "Key=a;b"),
      fc.constantFrom("not an ini line at all", "]broken[", "="),
    ),
    { maxLength: 40 },
  )
  .chain((lines) =>
    fc
      .tuple(fc.constantFrom("\n", "\r\n"), fc.boolean())
      .map(([eol, trailing]) => lines.join(eol) + (trailing ? eol : "")),
  );

describe("round-trip", () => {
  it("returns any input unchanged", () => {
    fc.assert(
      fc.property(iniText, (text) => {
        expect(IniDocument.parse(text).toString()).toBe(text);
      }),
      { numRuns: 500 },
    );
  });

  it("returns real config files unchanged, byte for byte", () => {
    for (const name of ["fallout2.cfg", "f2_res.ini", "ddraw.ini"]) {
      const bytes = new Uint8Array(readFileSync(`fixtures/f2up/${name}`));
      const out = IniDocument.parseBytes(bytes).toBytes();
      expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("preserves bytes above 0x7f", () => {
    // No available fixture carries high bytes, but a localized install can: paths and translation settings are
    // written in a legacy codepage. Decoding those as UTF-8 is irreversible, so the guard is synthesized.
    const bytes = Uint8Array.from([
      ...Buffer.from("[sound]\r\nmusic_path1=C:\\", "latin1"),
      0xc8,
      0xe3,
      0xf0,
      0xfb, // cp1251 for a Cyrillic directory name
      ...Buffer.from("\\music\r\n", "latin1"),
    ]);
    const doc = IniDocument.parseBytes(bytes);
    expect(Buffer.from(doc.toBytes()).equals(Buffer.from(bytes))).toBe(true);

    // The high bytes survive an unrelated edit to the same file.
    doc.set("sound", "music_path2", "data/sound/music/");
    expect(Buffer.from(doc.toBytes()).subarray(0, bytes.length - 2)).toEqual(
      Buffer.from(bytes).subarray(0, bytes.length - 2),
    );
  });
});

describe("set", () => {
  const sample = "; header\r\n[Main]\r\nAlpha=1\r\nBeta = 2\r\n\r\n[Other]\r\nGamma=3\r\n";

  it("changes exactly one line", () => {
    const doc = IniDocument.parse(sample);
    doc.set("Main", "Alpha", "9");
    const before = sample.split("\r\n");
    const after = doc.toString().split("\r\n");
    const differing = before.filter((line, i) => line !== after[i]);
    expect(differing).toEqual(["Alpha=1"]);
  });

  it("preserves the surrounding spacing style", () => {
    const doc = IniDocument.parse(sample);
    doc.set("Main", "Beta", "7");
    expect(doc.toString()).toContain("Beta = 7");
  });

  it("is a no-op when the value is unchanged", () => {
    const doc = IniDocument.parse(sample);
    doc.set("Main", "Alpha", "1");
    expect(doc.toString()).toBe(sample);
  });

  it("matches section and key case-insensitively but writes the original spelling", () => {
    const doc = IniDocument.parse(sample);
    doc.set("main", "alpha", "5");
    expect(doc.toString()).toContain("Alpha=5");
    expect(doc.get("MAIN", "ALPHA")).toBe("5");
  });

  it("appends a missing key to the end of its section, not the end of the file", () => {
    const doc = IniDocument.parse(sample);
    doc.set("Main", "Delta", "4");
    const lines = doc.toString().split("\r\n");
    expect(lines.indexOf("Delta=4")).toBeLessThan(lines.indexOf("[Other]"));
  });

  it("appends a missing section at the end", () => {
    const doc = IniDocument.parse(sample);
    doc.set("Fresh", "Key", "1");
    expect(doc.toString().endsWith("[Fresh]\r\nKey=1\r\n")).toBe(true);
  });

  it("does not splice onto a preceding line that has no terminator", () => {
    // Real config files need not end with a newline: the bundled ddraw.ini ends "DisablePipboyAlarm=0" with
    // nothing after it, so appending to that section joined the two keys into one unparseable line.
    const doc = IniDocument.parse("[Main]\r\nAlpha=1\r\n[Misc]\r\nBeta=2");
    doc.set("Misc", "Gamma", "3");
    expect(doc.toString()).toBe("[Main]\r\nAlpha=1\r\n[Misc]\r\nBeta=2\r\nGamma=3\r\n");
  });

  it("appends cleanly to a real file that ends without a newline", () => {
    const doc = IniDocument.parseBytes(new Uint8Array(readFileSync("fixtures/f2up/ddraw.ini")));
    doc.set("Misc", "CombatPanelAnimDelay", "4");
    const text = doc.toString();
    expect(text).not.toContain("DisablePipboyAlarm=0CombatPanelAnimDelay");
    expect(text).toContain("DisablePipboyAlarm=0\r\nCombatPanelAnimDelay=4");
    expect(IniDocument.parse(text).get("Misc", "DisablePipboyAlarm")).toBe("0");
  });

  it("does not splice onto a final line that has no terminator", () => {
    const doc = IniDocument.parse("[Main]\nAlpha=1");
    doc.set("Other", "Beta", "2");
    expect(doc.toString()).toBe("[Main]\nAlpha=1\n[Other]\nBeta=2\n");
  });
});

describe("get", () => {
  it("reads the first occurrence of a duplicated key", () => {
    const doc = IniDocument.parse("[S]\nK=first\nK=second\n");
    expect(doc.get("S", "K")).toBe("first");
  });

  it("returns undefined for absent section or key", () => {
    const doc = IniDocument.parse("[S]\nK=v\n");
    expect(doc.get("S", "Missing")).toBeUndefined();
    expect(doc.get("Missing", "K")).toBeUndefined();
  });
});

describe("inline comments", () => {
  const sample = "[MAPS]\r\nSCROLL_DIST_X=HALF_SCRN ; ORIGINAL 480\r\n";

  it("excludes an inline comment from the value", () => {
    expect(IniDocument.parse(sample).get("MAPS", "SCROLL_DIST_X")).toBe("HALF_SCRN");
  });

  it("keeps the comment when the value is rewritten", () => {
    const doc = IniDocument.parse(sample);
    doc.set("MAPS", "SCROLL_DIST_X", "FULL_SCRN");
    expect(doc.toString()).toBe("[MAPS]\r\nSCROLL_DIST_X=FULL_SCRN ; ORIGINAL 480\r\n");
  });

  it("does not treat a separator inside a value as a comment", () => {
    const doc = IniDocument.parse("[S]\nPath=data;mods;patches\nHash=a#b\n");
    expect(doc.get("S", "Path")).toBe("data;mods;patches");
    expect(doc.get("S", "Hash")).toBe("a#b");
  });

  it("round-trips a real file carrying inline comments", () => {
    const bytes = new Uint8Array(readFileSync("fixtures/f2up/f2_res.ini"));
    const doc = IniDocument.parseBytes(bytes);
    expect(doc.get("MAPS", "SCROLL_DIST_X")).toBe("HALF_SCRN");
    expect(Buffer.from(doc.toBytes()).equals(Buffer.from(bytes))).toBe(true);
  });
});
