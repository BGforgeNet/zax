import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { latin1Bytes } from "@zax/core";
import { parseManifest, type ModManifest } from "./manifest.js";
import { checkModIni, generateModIni } from "./mod-ini.js";

const manifest = (settings: string): ModManifest =>
  parseManifest(
    new TextEncoder().encode(`spec: 1
id: demo
name: Demo
version: "1"
game: fallout2
settings:
${settings}`),
  );

const SETTINGS = `  main.speed:
    kind: int
    label: Speed
    help: Frames per second.
    min: 16
    max: 100
    sentinels: { "0": disabled }
    default: 50
  main.walk:
    kind: bool
    label: Walk faster
    default: 1
  ncr.drive:
    kind: choice
    label: Brahmin drive
    options:
      - { value: 0, label: Once }
      - { value: 1, label: Repeatable }
    default: 1
`;

const INI = "[main]\r\nspeed=50\r\nwalk=1\r\n\r\n[ncr]\r\ndrive=1\r\n";

const files =
  (held: Record<string, string>) =>
  (file: string): Uint8Array | undefined =>
    held[file] === undefined ? undefined : latin1Bytes(held[file]);

describe("checkModIni", () => {
  it("matches a file carrying exactly what the settings describe, in both modes", () => {
    for (const match of ["soft", "hard"] as const) {
      expect(checkModIni(manifest(SETTINGS), files({ "mods/demo.ini": INI }), match)).toEqual({
        mismatches: [],
        undescribed: 0,
        files: ["mods/demo.ini"],
      });
    }
  });

  it("folds names as the engine does", () => {
    const shouted = "[MAIN]\r\nSpeed=50\r\nWALK=1\r\n[Ncr]\r\ndrive=1\r\n";
    expect(checkModIni(manifest(SETTINGS), files({ "mods/demo.ini": shouted }), "hard").mismatches).toEqual([]);
  });

  it("lets soft pass over what the manifest leaves out, and hard name every piece of it", () => {
    const wider = `${INI}keymap_a=30\r\n[empty]\r\n[keymap]\r\nb=48\r\n`;
    const soft = checkModIni(manifest(SETTINGS), files({ "mods/demo.ini": wider }), "soft");
    expect(soft).toMatchObject({ mismatches: [], undescribed: 2 });
    expect(checkModIni(manifest(SETTINGS), files({ "mods/demo.ini": wider }), "hard").mismatches).toEqual([
      "mods/demo.ini [ncr] keymap_a: in the file, not described by the manifest",
      "mods/demo.ini [keymap] b: in the file, not described by the manifest",
      "mods/demo.ini [empty]: an empty section the manifest does not describe",
    ]);
  });

  it("refuses in either mode a described key the file lacks, and a file that is absent", () => {
    const short = "[main]\r\nspeed=50\r\n";
    expect(checkModIni(manifest(SETTINGS), files({ "mods/demo.ini": short }), "soft").mismatches).toEqual([
      "mods/demo.ini [main] walk: described by the manifest, absent from the file",
      "mods/demo.ini [ncr] drive: described by the manifest, absent from the file",
    ]);
    expect(checkModIni(manifest(SETTINGS), files({}), "soft").mismatches).toEqual([
      "mods/demo.ini: absent, and the manifest describes 3 setting(s) in it",
    ]);
  });

  it("names a default the file disagrees with, and a value the setting's kind cannot hold", () => {
    const off = "[main]\r\nspeed=8\r\nwalk=yes\r\n[ncr]\r\ndrive=2\r\n";
    expect(checkModIni(manifest(SETTINGS), files({ "mods/demo.ini": off }), "soft").mismatches).toEqual([
      `mods/demo.ini [main] speed: the file ships "8", the manifest's default is "50"`,
      `mods/demo.ini [main] speed: the file ships "8" - Must be at least 16`,
      `mods/demo.ini [main] walk: the file ships "yes", the manifest's default is "1"`,
      `mods/demo.ini [main] walk: the file ships "yes" - Not its on value "1" or its off value "0"`,
      `mods/demo.ini [ncr] drive: the file ships "2", the manifest's default is "1"`,
      `mods/demo.ini [ncr] drive: the file ships "2" - 2 is not one of the supported values`,
    ]);
  });

  it("accepts a sentinel the range would refuse, and judges no value where no default is stated", () => {
    const loose = manifest(`  main.speed:
    kind: int
    label: Speed
    min: 16
    sentinels: { "0": disabled }
`);
    expect(checkModIni(loose, files({ "mods/demo.ini": "[main]\nspeed=0\n" }), "hard").mismatches).toEqual([]);
  });

  it("checks each file a setting names on its own", () => {
    const split = manifest(`  main.a: { kind: bool, label: A, default: 1 }
  main.b: { kind: bool, label: B, default: 0, file: mods/other.ini }
`);
    const report = checkModIni(
      split,
      files({ "mods/demo.ini": "[main]\na=1\n", "mods/other.ini": "[main]\nb=0\n" }),
      "hard",
    );
    expect(report).toEqual({ mismatches: [], undescribed: 0, files: ["mods/demo.ini", "mods/other.ini"] });
  });

  it("fails on a setting this version dropped, without also calling its key undescribed", () => {
    const later = manifest(`  main.a: { kind: bool, label: A, default: 1 }
  main.dial: { kind: dial, label: Dial }
`);
    expect(checkModIni(later, files({ "mods/demo.ini": "[main]\na=1\ndial=3\n" }), "hard").mismatches).toEqual([
      `"main.dial" cannot be checked: its kind "dial" is not one this version knows`,
    ]);
  });

  it("stays silent over the drafted FO2tweaks schema and its real ini when soft, and counts what hard would refuse", () => {
    const drafted = parseManifest(new Uint8Array(readFileSync("fixtures/fo2tweaks/f2mod.yml")), { version: "14.7" });
    const read = (file: string) =>
      file === "mods/fo2tweaks.ini" ? new Uint8Array(readFileSync("fixtures/fo2tweaks/mods/fo2tweaks.ini")) : undefined;
    const soft = checkModIni(drafted, read, "soft");
    expect(soft.mismatches).toEqual([]);
    expect(soft.undescribed).toBeGreaterThan(0);
    // Hard names each of those, plus the sections upstream ships holding comments alone.
    const hard = checkModIni(drafted, read, "hard").mismatches;
    expect(hard.filter((line) => line.endsWith("not described by the manifest"))).toHaveLength(soft.undescribed);
    expect(hard.filter((line) => !line.endsWith("not described by the manifest"))).toEqual([
      "mods/fo2tweaks.ini [party_level_maxstage]: an empty section the manifest does not describe",
      "mods/fo2tweaks.ini [damage_mod_ammo_dr]: an empty section the manifest does not describe",
    ]);
  });
});

describe("generateModIni", () => {
  const text = (bytes: Uint8Array | undefined) => new TextDecoder("latin1").decode(bytes);

  it("writes a section per section, each setting's help above its default, and its label where it has no help", () => {
    const written = generateModIni(manifest(SETTINGS), () => undefined);
    expect([...written.keys()]).toEqual(["mods/demo.ini"]);
    expect(text(written.get("mods/demo.ini"))).toBe(
      [
        "[main]",
        "; Frames per second.",
        "; 16 to 100, or 0 (disabled)",
        "speed=50",
        "",
        "; Walk faster",
        "walk=1",
        "",
        "[ncr]",
        "; Brahmin drive",
        "; One of: 0 (Once), 1 (Repeatable)",
        "drive=1",
        "",
      ].join("\r\n"),
    );
  });

  it("writes what a hard check then matches, and the same bytes a second time", () => {
    const described = manifest(SETTINGS);
    const first = generateModIni(described, () => undefined);
    expect(checkModIni(described, (file) => first.get(file), "hard").mismatches).toEqual([]);
    expect(generateModIni(described, (file) => first.get(file))).toEqual(first);
  });

  it("replaces whatever the file held, keeping only its line terminator", () => {
    const written = generateModIni(manifest(SETTINGS), files({ "mods/demo.ini": "[old]\nstale=1\n" }));
    const out = text(written.get("mods/demo.ini"));
    expect(out).not.toContain("stale");
    expect(out).not.toContain("\r");
  });

  it("spells out a one-sided range, a unit, and sentinels with no range", () => {
    const ranges = manifest(`  main.a: { kind: int, label: A, min: 1, unit: px, default: 1 }
  main.b: { kind: float, label: B, max: 2.5, default: 1 }
  main.c: { kind: int, label: C, sentinels: { "-1": auto }, default: -1 }
  main.d: { kind: scale, label: D, max: 32767, default: 0 }
  main.e: { kind: text, label: E, default: x }
`);
    const out = text(generateModIni(ranges, () => undefined).get("mods/demo.ini"));
    expect(out).toContain("; At least 1 px\r\na=1");
    expect(out).toContain("; At most 2.5\r\nb=1");
    expect(out).toContain("; Also: -1 (auto)\r\nc=-1");
    expect(out).toContain("; 0 to 32767\r\nd=0");
    expect(out).toContain("; E\r\ne=x");
  });

  it("refuses a setting with no default, naming it", () => {
    const bare = manifest(`  main.a: { kind: bool, label: A, default: 1 }
  main.b: { kind: bool, label: B }
`);
    expect(() => generateModIni(bare, () => undefined)).toThrow(`demo.main.b: no "default" stated`);
  });

  it("writes a section's description above its header, a line apiece, and nothing where a section has none", () => {
    const described = parseManifest(
      new TextEncoder().encode(`spec: 1
id: demo
name: Demo
version: "1"
game: fallout2
settings.sections.main: |
  Turn each component on or off.
  Tune them below.
settings:
  main.a: { kind: bool, label: A, default: 1 }
  tuning.b: { kind: bool, label: B, default: 0 }
`),
    );
    expect(text(generateModIni(described, () => undefined).get("mods/demo.ini"))).toBe(
      [
        "; Turn each component on or off.",
        "; Tune them below.",
        "[main]",
        "; A",
        "a=1",
        "",
        "[tuning]",
        "; B",
        "b=0",
        "",
      ].join("\r\n"),
    );
  });

  it("refuses a section description the game's encoding cannot carry, naming its key", () => {
    const dash = String.fromCodePoint(0x2014);
    const described = parseManifest(
      new TextEncoder().encode(
        `spec: 1\nid: demo\nname: Demo\nversion: "1"\ngame: fallout2\nsettings.sections.main: "a ${dash} b"\nsettings:\n  main.a: { kind: bool, label: A, default: 1 }\n`,
      ),
    );
    expect(() => generateModIni(described, () => undefined)).toThrow(
      `settings.sections.main: "${dash}" has no latin1 byte`,
    );
  });

  it("refuses a character the game's encoding cannot carry, naming the setting", () => {
    // An em dash, escaped so the source stays ASCII: a character past latin1 is the case under test.
    const dashed = manifest(`  main.a: { kind: bool, label: "On \u2014 or off", default: 1 }
`);
    expect(() => generateModIni(dashed, () => undefined)).toThrow(/^demo\.main\.a: "\u2014" has no latin1 byte/);
  });

  it("refuses a schema it cannot write whole, or one with nothing in it", () => {
    expect(() => generateModIni(manifest(`  main.dial: { kind: dial, label: Dial }\n`), () => undefined)).toThrow(
      /"main\.dial"/,
    );
    const empty = parseManifest(
      new TextEncoder().encode(`spec: 1\nid: demo\nname: Demo\nversion: "1"\ngame: fallout2\n`),
    );
    expect(() => generateModIni(empty, () => undefined)).toThrow("demo describes no settings");
  });
});
