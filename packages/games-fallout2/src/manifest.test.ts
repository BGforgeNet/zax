import { describe, expect, it } from "vitest";
import { MANIFEST_BYTE_CAP, MANIFEST_SPEC, mayWrite, parseManifest, type ModManifest } from "./manifest.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const parsed = (text: string): ModManifest => parseManifest(bytes(text));

/** The whole authored FO2tweaks manifest: five lines, everything else convention. */
const FO2TWEAKS = `spec: 1
id: fo2tweaks
name: FO2tweaks
version: "14.7"
game: fallout2
`;

describe("parseManifest", () => {
  it("reads the five-line manifest, with every default landing", () => {
    const manifest = parsed(FO2TWEAKS);
    expect(manifest).toEqual({
      id: "fo2tweaks",
      name: "FO2tweaks",
      version: "14.7",
      type: "pluggable",
      refuse: [],
      settings: [],
    });
  });

  it("reads an unquoted version as the string the tag carries", () => {
    expect(parsed(FO2TWEAKS.replace('"14.7"', "14.7")).version).toBe("14.7");
  });

  it("reads a full manifest", () => {
    const manifest = parsed(`spec: 1
id: ecco
name: EcCo Gameplay Overhaul
version: "1.0.0"
game: fallout2
type: permanent
reason: EcCo's changes live in the save; removing it breaks every save made while it was in.
archive: ecco_v1-0-0.zip
install-on: [fallout2rpu]
requires:
  sfall: ">=4.4.5"
state: [mods/ecco/combat.ini]
refuse:
  - when: { present: [mods/other.dat], absent: [mods/ecco.dat] }
    reason: Not with Other installed.
settings:
  main.enabled:
    file: mods/ecco/combat.ini
    kind: bool
    on: 1
    off: 0
    default: 1
    label: Combat rebalance
  main.level:
    file: mods/ecco/combat.ini
    kind: int
    min: 0
    max: 10
    sentinels: { 0: "Off" }
    default: 3
    label: Level
    gated-by: { id: ecco.main.enabled, is: [1] }
  main.mode:
    file: mods/ecco/combat.ini
    kind: choice
    options:
      - { value: 0, label: Classic }
      - { value: 1, label: Rebalanced }
    label: Mode
    gated-by: { id: hires.MAIN.WINDOWED, is-not: [0] }
`);
    expect(manifest.type).toBe("permanent");
    expect(manifest.reason).toContain("breaks every save");
    expect(manifest.archive).toBe("ecco_v1-0-0.zip");
    expect(manifest.installOn).toEqual(["fallout2rpu"]);
    expect(manifest.requiresSfall).toBe("4.4.5");
    expect(manifest.state).toEqual(["mods/ecco/combat.ini"]);
    expect(manifest.refuse).toEqual([
      { present: ["mods/other.dat"], absent: ["mods/ecco.dat"], reason: "Not with Other installed." },
    ]);
    const [enabled, level, mode] = manifest.settings;
    expect(enabled?.id).toBe("ecco.main.enabled");
    // YAML reads bare 1 as a number; the file's literal is the string.
    expect(enabled?.kind).toEqual({ type: "bool", onValue: "1", offValue: "0" });
    expect(enabled?.default).toBe("1");
    expect(enabled?.file).toBe("mods/ecco/combat.ini");
    expect(level?.kind).toEqual({ type: "int", min: 0, max: 10, sentinels: { "0": "Off" } });
    // A gate may name a sibling entry or a catalog id; both resolve.
    expect(level?.gatedBy).toEqual({ id: "ecco.main.enabled", is: ["1"] });
    expect(mode?.gatedBy).toEqual({ id: "hires.MAIN.WINDOWED", isNot: ["0"] });
  });

  it("derives the id and the default file from the address", () => {
    const manifest = parsed(`${FO2TWEAKS}settings:
  run_speed.dude_speed:
    kind: bool
    label: Speed
`);
    const [setting] = manifest.settings;
    // The id is the mod's id plus the address, verbatim - the same rule the catalog's generator applies.
    expect(setting?.id).toBe("fo2tweaks.run_speed.dude_speed");
    expect(setting?.file).toBe("mods/fo2tweaks.ini");
    expect(setting?.section).toBe("run_speed");
    expect(setting?.key).toBe("dude_speed");
    // Omitted on/off are the ini convention's 1/0.
    expect(setting?.kind).toEqual({ type: "bool", onValue: "1", offValue: "0" });
  });

  it("normalizes backslashes in paths", () => {
    const manifest = parsed(`${FO2TWEAKS}state: ["mods\\\\fo2tweaks.ini"]\n`);
    expect(manifest.state).toEqual(["mods/fo2tweaks.ini"]);
  });

  it("ignores the extra block, the one place leniency lives", () => {
    expect(parsed(`${FO2TWEAKS}extra:\n  anything: { nested: [1, 2] }\n`).id).toBe("fo2tweaks");
  });
});

it("reads the entries a mod declares it puts under mods/, keeping the loader's own spelling", () => {
  // The loader names an entry relative to `mods\`, and these become its lines verbatim - so a folder mod
  // whose entry happens to end in `.dat` is expressible where a derivation from the payload's paths is not.
  const manifest = parsed(`${FO2TWEAKS}entries: [InventoryFilter.dat, "patches/extra.dat"]\n`);
  expect(manifest.entries).toEqual(["InventoryFilter.dat", "patches/extra.dat"]);
});

it("leaves entries absent when the manifest declares none, so the payload still decides", () => {
  expect(parsed(FO2TWEAKS).entries).toBeUndefined();
});

describe("parseManifest refusals", () => {
  const refuses = (text: string, cause: RegExp | string) => expect(() => parsed(text)).toThrow(cause);

  it("refuses bytes past the cap before parsing", () => {
    const padded = FO2TWEAKS + `extra: "${"x".repeat(MANIFEST_BYTE_CAP)}"\n`;
    refuses(padded, /byte cap/);
  });

  it("refuses an alias flood", () => {
    const flood = `${FO2TWEAKS}extra:\n  a: &a [x, x, x]\n  b: [${Array(100).fill("*a").join(", ")}]\n`;
    refuses(flood, /does not parse/);
  });

  it("refuses bytes that are not UTF-8", () => {
    expect(() => parseManifest(new Uint8Array([0xff, 0xfe, 0x00]))).toThrow(/does not parse/);
  });

  it("refuses YAML that does not parse", () => {
    refuses("spec: [unclosed", /does not parse/);
  });

  it("refuses an unknown field, so a misspelling cannot drop a safety check", () => {
    refuses(`${FO2TWEAKS}refuze: []\n`, /unknown field "refuze"/);
  });

  it("reads the spec number as a floor rather than a pin", () => {
    // The pin was the defect: once spec 2 is implemented it would have refused every spec-1 manifest. What
    // refuses is a manifest asking for more than this version implements, whatever this version implements.
    expect(parsed(FO2TWEAKS.replace("spec: 1", `spec: ${MANIFEST_SPEC}`)).id).toBe("fo2tweaks");
    refuses(FO2TWEAKS.replace("spec: 1", `spec: ${MANIFEST_SPEC + 1}`), /newer version of ZAX/);
  });

  it("answers a later spec ahead of the unknown field that spec brought", () => {
    // The order is the whole point of the floor: a spec-2 manifest carries fields this version has no name
    // for, and being told to update ZAX is the answer to that, not being told one of them is misspelled.
    refuses(`${FO2TWEAKS.replace("spec: 1", "spec: 2")}whatever-spec-2-adds: yes\n`, /newer version of ZAX/);
  });

  it("refuses a spec that is not a whole number, rather than reading it as a later one", () => {
    refuses(FO2TWEAKS.replace("spec: 1\n", ""), /"spec"/);
    refuses(FO2TWEAKS.replace("spec: 1", "spec: one"), /"spec"/);
    refuses(FO2TWEAKS.replace("spec: 1", "spec: 1.5"), /"spec"/);
    refuses(FO2TWEAKS.replace("spec: 1", "spec: 0"), /"spec"/);
  });

  it("refuses another game's manifest", () => {
    refuses(FO2TWEAKS.replace("game: fallout2", "game: arcanum"), /not Fallout 2/);
  });

  it("refuses a base mod as needing a newer ZAX", () => {
    refuses(`${FO2TWEAKS}type: base\n`, /newer version of ZAX/);
    refuses(`${FO2TWEAKS}install:\n  - deploy: {}\n`, /newer version of ZAX/);
    refuses(`${FO2TWEAKS}type: overlay\n`, /newer version of ZAX/);
  });

  it("requires a reason of a permanent mod and refuses one elsewhere", () => {
    refuses(`${FO2TWEAKS}type: permanent\n`, /must say why/);
    refuses(`${FO2TWEAKS}reason: because\n`, /belongs to permanent mods/);
  });

  it("refuses ids and versions that could not become paths or feed matches", () => {
    refuses(FO2TWEAKS.replace("id: fo2tweaks", "id: FO2 Tweaks"), /is not an id/);
    refuses(FO2TWEAKS.replace('version: "14.7"', 'version: "../14"'), /is not a version/);
  });

  it("refuses every path shape that could leave the game directory", () => {
    refuses(`${FO2TWEAKS}state: ["mods/../fallout2.exe"]\n`, /leaves the game directory/);
    refuses(`${FO2TWEAKS}state: ["/etc/passwd"]\n`, /leaves the game directory/);
    refuses(`${FO2TWEAKS}state: ["C:\\\\game\\\\mods\\\\a.ini"]\n`, /leaves the game directory/);
    refuses(`${FO2TWEAKS}refuse:\n  - when: { present: ["../marker"] }\n    reason: no\n`, /leaves the game directory/);
  });

  it("confines a stacking mod's files to mods/, naming the grant as ZAX's rather than the mod's fault", () => {
    refuses(`${FO2TWEAKS}state: [data/scripts/gl_a.int]\n`, /outside what ZAX grants fo2tweaks/);
    const outside = `${FO2TWEAKS}settings:\n  main.a:\n    { file: ddraw.ini, kind: key, label: A }\n`;
    refuses(outside, /outside what ZAX grants fo2tweaks/);
    // Where to ask matters as much as the refusal: the list is ZAX's, so a mod that needs a path it does not
    // hold is a ZAX release to ask for, not a bug to report to the mod's author.
    refuses(outside, /ZAX's to give, not the manifest's to claim/);
  });

  it("refuses a settings block that is not the flat mapping", () => {
    refuses(`${FO2TWEAKS}settings: []\n`, /must be a mapping/);
  });

  it("refuses an address that is not section.key", () => {
    const entry = (address: string) => `${FO2TWEAKS}settings:\n  ${address}:\n    { kind: key, label: A }\n`;
    refuses(entry("nodot"), /not a "section.key" address/);
    refuses(entry(".key"), /not a "section.key" address/);
    refuses(entry("section."), /not a "section.key" address/);
  });

  it("refuses a gate naming a setting nobody defines", () => {
    const gated = `${FO2TWEAKS}settings:
  main.a: { kind: bool, label: A, gated-by: { id: nothing.known, is: [1] } }
`;
    refuses(gated, /not a setting this version knows/);
  });

  it("refuses gates that test both ways or neither", () => {
    const both = `${FO2TWEAKS}settings:
  main.a: { kind: bool, label: A, gated-by: { id: fo2tweaks.main.a, is: [1], is-not: [0] } }
`;
    refuses(both, /exactly one of "is" and "is-not"/);
  });

  it("refuses an address whose characters could not become an id", () => {
    refuses(`${FO2TWEAKS}settings:\n  "main.a b": { kind: key, label: K }\n`, /cannot become an id/);
  });

  it("reserves the catalog's prefixes, so a mod cannot mint ids inside the engine's namespaces", () => {
    // Refused with or without settings: the id itself is the claim on the namespace, and the per-id collision
    // check could only see the catalog as it is today.
    refuses(FO2TWEAKS.replace("id: fo2tweaks", "id: hires"), /catalog's "hires" namespace/);
    refuses(FO2TWEAKS.replace("id: fo2tweaks", "id: sfall.extra"), /catalog's "sfall" namespace/);
    refuses(FO2TWEAKS.replace("id: fo2tweaks", "id: game"), /catalog's "game" namespace/);
  });

  it("refuses a kind this version does not know as needing a newer ZAX", () => {
    refuses(`${FO2TWEAKS}settings:\n  main.a: { kind: table, label: A }\n`, /newer version of ZAX/);
  });

  it("refuses a kind payload field on the wrong kind", () => {
    refuses(`${FO2TWEAKS}settings:\n  main.a: { kind: bool, options: [], label: A }\n`, /unknown field "options"/);
  });

  it("refuses control characters in text", () => {
    refuses(FO2TWEAKS.replace("name: FO2tweaks", 'name: "FO2\\u0007tweaks"'), /control characters/);
  });

  it("refuses a requires bound that is not >=", () => {
    refuses(`${FO2TWEAKS}requires:\n  sfall: "4.1.3"\n`, /not a ">=version" bound/);
  });

  it("refuses install-on naming an unknown game type, or nothing", () => {
    refuses(`${FO2TWEAKS}install-on: [fallout3]\n`, /newer version of ZAX/);
    refuses(`${FO2TWEAKS}install-on: []\n`, /install nowhere/);
  });

  it("refuses a refuse rule that tests nothing", () => {
    refuses(`${FO2TWEAKS}refuse:\n  - when: {}\n    reason: no\n`, /tests nothing/);
  });

  it("refuses an archive name that is not a bare file name", () => {
    refuses(`${FO2TWEAKS}archive: ../elsewhere.zip\n`, /not a file name/);
    refuses(`${FO2TWEAKS}archive: "sub/dir.zip"\n`, /not a file name/);
  });
});

describe("entries refusals", () => {
  it("refuses an entry that could leave the mods folder", () => {
    expect(() => parsed(`${FO2TWEAKS}entries: ["../rpu.dat"]\n`)).toThrow(/leaves the game directory/);
  });

  it("refuses an empty entries list, which would order nothing while claiming to", () => {
    expect(() => parsed(`${FO2TWEAKS}entries: []\n`)).toThrow(/"entries" is empty/);
  });
});

describe("mayWrite", () => {
  it("lets any mod write under mods/ and nowhere else", () => {
    expect(mayWrite("mods/fo2tweaks.dat", [])).toBe(true);
    expect(mayWrite("mods/patches/extra.dat", [])).toBe(true);
    // The folder itself is not something to write into, and everything beside it is off limits.
    expect(mayWrite("mods", [])).toBe(false);
    expect(mayWrite("data/sound/music/track.acm", [])).toBe(false);
  });

  it("lets a granted mod write below the directories it was granted", () => {
    const granted = ["data/sound/music"];
    expect(mayWrite("data/sound/music/track.acm", granted)).toBe(true);
    expect(mayWrite("data/sound/music/deep/track.acm", granted)).toBe(true);
    // Matched as the engine matches paths, and by segment - so a longer name that merely starts the same is
    // a different directory, which a string prefix would have let through.
    expect(mayWrite("Data/Sound/Music/track.acm", granted)).toBe(true);
    expect(mayWrite("data/sound/musical/track.acm", granted)).toBe(false);
    expect(mayWrite("data/sound/sfx/track.acm", granted)).toBe(false);
    expect(mayWrite("data/sound/music", granted)).toBe(false);
  });

  it("widens where a mod writes, never how far - an escape is still an escape", () => {
    const granted = ["data/sound/music"];
    expect(mayWrite("data/sound/music/../../../elsewhere/x", granted)).toBe(false);
    expect(mayWrite("/data/sound/music/x", granted)).toBe(false);
    expect(mayWrite("C:/data/sound/music/x", granted)).toBe(false);
    expect(mayWrite("mods/../data/sound/music/x", granted)).toBe(false);
  });
});
