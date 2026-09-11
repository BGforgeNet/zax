import { describe, expect, it } from "vitest";
import { ownTarget } from "@zax/core";
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
      conflicts: [],
      settings: [],
      dropped: [],
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
needs.game: [fallout2rpu]
needs.sfall: "4.4.5"
conflicts:
  - present: [mods/other.dat]
    absent: [mods/ecco.dat]
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
    expect(manifest.conflicts).toEqual([
      { present: ["mods/other.dat"], absent: ["mods/ecco.dat"], reason: "Not with Other installed." },
    ]);
    const [enabled, level, mode] = manifest.settings;
    expect(enabled?.id).toBe("ecco.main.enabled");
    // YAML reads bare 1 as a number; the file's literal is the string.
    expect(enabled?.kind).toEqual({ type: "bool", onValue: "1", offValue: "0" });
    expect(enabled?.default).toBe("1");
    expect(enabled?.targets).toEqual([{ file: "mods/ecco/combat.ini", section: "main", key: "enabled" }]);
    expect(level?.kind).toEqual({ type: "int", min: 0, max: 10, sentinels: { "0": "Off" } });
    // A gate may name a sibling entry or a catalog id; both resolve.
    expect(level && ownTarget(level).gatedBy).toEqual({ id: "ecco.main.enabled", is: ["1"] });
    expect(mode && ownTarget(mode).gatedBy).toEqual({ id: "hires.MAIN.WINDOWED", isNot: ["0"] });
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
    // A mod setting writes one address; linking across engines is the catalog's business, not a manifest's.
    expect(setting?.targets).toEqual([{ file: "mods/fo2tweaks.ini", section: "run_speed", key: "dude_speed" }]);
    // Omitted on/off are the ini convention's 1/0.
    expect(setting?.kind).toEqual({ type: "bool", onValue: "1", offValue: "0" });
  });

  it("normalizes backslashes in paths", () => {
    const manifest = parsed(
      `${FO2TWEAKS}settings:\n  main.a: { kind: bool, label: A, file: "mods\\\\fo2tweaks.ini" }\n`,
    );
    expect(manifest.settings[0]?.targets).toEqual([{ file: "mods/fo2tweaks.ini", section: "main", key: "a" }]);
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
    const padded = FO2TWEAKS + `# ${"x".repeat(MANIFEST_BYTE_CAP)}\n`;
    refuses(padded, /byte cap/);
  });

  it("refuses an alias flood", () => {
    const flood = `${FO2TWEAKS}conflicts:\n  a: &a [x, x, x]\n  b: [${Array(100).fill("*a").join(", ")}]\n`;
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

  it("refuses a mod type or an install procedure this version does not implement", () => {
    // Base mods install now; what a base manifest still owes is an installer to run.
    refuses(`${FO2TWEAKS}type: base\n`, /names no "installer"/);
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
    const setting = (file: string) => `${FO2TWEAKS}settings:\n  main.a: { kind: bool, label: A, file: "${file}" }\n`;
    refuses(setting("mods/../fallout2.exe"), /leaves the game directory/);
    refuses(setting("/etc/passwd"), /leaves the game directory/);
    refuses(setting("C:\\\\game\\\\mods\\\\a.ini"), /leaves the game directory/);
    refuses(`${FO2TWEAKS}conflicts:\n  - present: ["../marker"]\n    reason: no\n`, /leaves the game directory/);
  });

  it("confines a stacking mod's files to mods/, naming the grant as ZAX's rather than the mod's fault", () => {
    refuses(
      `${FO2TWEAKS}settings:\n  main.a: { kind: bool, label: A, file: data/scripts/gl_a.int }\n`,
      /outside what ZAX grants fo2tweaks/,
    );
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

  it("drops a control gated on a setting nobody defines, and the mod with it stays installable", () => {
    const gated = `${FO2TWEAKS}settings:
  main.a: { kind: bool, label: A, gated-by: { id: nothing.known, is: [1] } }
  main.b: { kind: bool, label: B }
`;
    const manifest = parsed(gated);
    expect(manifest.settings.map((s) => s.id)).toEqual(["fo2tweaks.main.b"]);
    expect(manifest.dropped).toEqual([
      { address: "main.a", why: 'it waits on "nothing.known", which this version cannot show' },
    ]);
  });

  it("drops whatever waited on a control it dropped, however deep the chain", () => {
    const chain = `${FO2TWEAKS}settings:
  main.a: { kind: table, label: A }
  main.b: { kind: bool, label: B, gated-by: { id: fo2tweaks.main.a, is: [1] } }
  main.c: { kind: bool, label: C, gated-by: { id: fo2tweaks.main.b, is: [1] } }
  main.d: { kind: bool, label: D }
`;
    const manifest = parsed(chain);
    // A control gated on one that is not there would render live and never take effect, which is the failure
    // gates exist to prevent - so the whole chain goes and the ungated sibling stays.
    expect(manifest.settings.map((s) => s.id)).toEqual(["fo2tweaks.main.d"]);
    expect(manifest.dropped.map((d) => d.address).toSorted()).toEqual(["main.a", "main.b", "main.c"]);
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

  it("drops a control whose kind it does not know, carrying the rest of the schema", () => {
    // A settings entry only ever edits a key in the mod's own ini, and the release ships its own default
    // there - so an unrenderable control costs a knob, never correctness, and refusing the mod over one
    // would make it uninstallable for sitting on the wrong side of a ZAX release.
    const manifest = parsed(`${FO2TWEAKS}settings:
  main.a: { kind: table, label: A, columns: 3 }
  main.b: { kind: bool, label: B }
`);
    expect(manifest.settings.map((s) => s.id)).toEqual(["fo2tweaks.main.b"]);
    expect(manifest.dropped).toEqual([{ address: "main.a", why: 'its kind "table" is not one this version knows' }]);
  });

  it("refuses a kind payload field on the wrong kind", () => {
    refuses(`${FO2TWEAKS}settings:\n  main.a: { kind: bool, options: [], label: A }\n`, /unknown field "options"/);
  });

  it("refuses control characters in text", () => {
    refuses(FO2TWEAKS.replace("name: FO2tweaks", 'name: "FO2\\u0007tweaks"'), /control characters/);
  });

  it("refuses an sfall floor that is not a version", () => {
    // The bare version is the whole vocabulary: an operator would promise a comparison nothing implements.
    refuses(`${FO2TWEAKS}needs.sfall: ">=4.1.3"\n`, /not a version/);
  });

  it("refuses a needed game type it cannot detect, or none at all", () => {
    refuses(`${FO2TWEAKS}needs.game: [fallout3]\n`, /newer version of ZAX/);
    refuses(`${FO2TWEAKS}needs.game: []\n`, /install nowhere/);
  });

  it("refuses a conflict rule that tests nothing", () => {
    refuses(`${FO2TWEAKS}conflicts:\n  - reason: no\n`, /tests nothing/);
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

describe("what a release says about itself", () => {
  it("reads the fields the interface shows", () => {
    const manifest = parsed(
      `${FO2TWEAKS}author: Lexx\ndescription: Small fixes and options.\nforum: https://example.test/thread\nhomepage: https://example.test/mod\n`,
    );
    expect(manifest).toMatchObject({
      author: "Lexx",
      description: "Small fixes and options.",
      forum: "https://example.test/thread",
      homepage: "https://example.test/mod",
    });
  });

  it("refuses an address that is not an https page", () => {
    // The value is handed to whatever the machine opens links with, so the scheme is the whole of the check.
    expect(() => parsed(`${FO2TWEAKS}forum: http://example.test/thread\n`)).toThrow(/not an https address/);
    expect(() => parsed(`${FO2TWEAKS}homepage: file:///etc/passwd\n`)).toThrow(/not an https address/);
    expect(() => parsed(`${FO2TWEAKS}forum: "https://example.test/a b"\n`)).toThrow(/not an https address/);
  });
});

describe("the place a mod states", () => {
  it("reads both sides, as entries rather than ids", () => {
    const manifest = parsed(
      `${FO2TWEAKS}order.overrides: [rpu.dat, party_orders.dat]\norder.overridden-by: [InventoryFilter.dat]\n`,
    );
    expect(manifest.order).toEqual({
      overrides: ["rpu.dat", "party_orders.dat"],
      overriddenBy: ["InventoryFilter.dat"],
    });
  });

  it("reads one side alone", () => {
    expect(parsed(`${FO2TWEAKS}order.overrides: [rpu.dat]\n`).order).toEqual({
      overrides: ["rpu.dat"],
      overriddenBy: [],
    });
  });

  it("states no place by default", () => {
    expect(parsed(FO2TWEAKS).order).toBeUndefined();
  });

  it("refuses a claim that names nothing to override and nothing to be overridden by", () => {
    expect(() => parsed(`${FO2TWEAKS}order.overrides: []\n`)).toThrow(/"order" names nothing/);
  });

  it("refuses a name that could leave the mods folder", () => {
    expect(() => parsed(`${FO2TWEAKS}order.overrides: ["../rpu.dat"]\n`)).toThrow(/leaves the game directory/);
  });

  it("refuses a side this version has no rule for, since the order it writes is on disk", () => {
    // The dotted spelling puts it through the manifest's own unknown-field pass rather than a per-wrapper
    // one, so the wording names the whole key - which is what an author reading it has to go and fix.
    expect(() => parsed(`${FO2TWEAKS}order.beside: [rpu.dat]\n`)).toThrow(/unknown field "order.beside"/);
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

/** Cassidy's real shape: an optional head, and a voice that only makes sense with it. */
const CASSIDY = `spec: 1
id: cassidy
name: Cassidy Restoration
version: "1.2"
game: fallout2
part-groups:
  - { id: head, label: Head, pick: any }
  - { id: voice, label: Voice, pick: one }
parts:
  - id: head
    group: head
    label: Cassidy's new head
    archive: cassidy_head.dat
    entries: [cassidy_head.dat]
  - id: voice-joey
    group: voice
    label: Joey Bracken
    help: The voice from the original release.
    archive: cassidy_voice_joey_bracken_hq.dat
    entries: [cassidy_voice_joey_bracken_hq.dat]
    needs: head
  - id: voice-tom
    group: voice
    label: Tom Regan
    archive: cassidy_voice_tom_regan_hq.dat
    entries: [cassidy_voice_tom_regan_hq.dat]
    needs: head
`;

describe("parts", () => {
  const refuses = (text: string, cause: RegExp) => expect(() => parsed(text)).toThrow(cause);

  it("reads groups and options in the order the manifest declares them", () => {
    const manifest = parsed(CASSIDY);
    expect(manifest.archive).toBeUndefined();
    expect(manifest.parts).toEqual([
      {
        label: "Head",
        pick: "any",
        options: [
          { id: "head", label: "Cassidy's new head", archive: "cassidy_head.dat", entries: ["cassidy_head.dat"] },
        ],
      },
      {
        label: "Voice",
        pick: "one",
        options: [
          {
            id: "voice-joey",
            label: "Joey Bracken",
            help: "The voice from the original release.",
            archive: "cassidy_voice_joey_bracken_hq.dat",
            entries: ["cassidy_voice_joey_bracken_hq.dat"],
            needs: "head",
          },
          {
            id: "voice-tom",
            label: "Tom Regan",
            archive: "cassidy_voice_tom_regan_hq.dat",
            entries: ["cassidy_voice_tom_regan_hq.dat"],
            needs: "head",
          },
        ],
      },
    ]);
  });

  it("refuses a manifest that claims both a payload and parts", () => {
    refuses(`${CASSIDY}archive: cassidy.zip\n`, /"archive" and "parts"/);
  });

  it("ignores a payload the release inferred, since the parts name their own", () => {
    // The release supplies its sole archive as a default. A parts manifest states no top-level payload, so
    // the supplied one describes nothing this install would deploy - and it is not the release's fault.
    const supplied = parseManifest(bytes(CASSIDY), { archive: "cassidy.zip" });
    expect(supplied.archive).toBeUndefined();
  });

  it("refuses a group no part is in, and a pair where either list is empty", () => {
    // A group nothing joined draws a heading over an empty box, which is the shape the nested format made
    // unrepresentable and this one does not: the two lists are written apart and can disagree.
    const spare = CASSIDY.replace(
      "  - { id: voice, label: Voice, pick: one }",
      "  - { id: voice, label: Voice, pick: one }\n  - { id: spare, label: Spare, pick: any }",
    );
    refuses(spare, /no part is in the group "spare"/);
    refuses(`${FO2TWEAKS}part-groups: []\nparts: []\n`, /empty/);
  });

  it("refuses one of the two lists without the other, which describes half a choice", () => {
    const groupsOnly = CASSIDY.slice(0, CASSIDY.indexOf("parts:\n"));
    refuses(groupsOnly, /declared together/);
    refuses(`${FO2TWEAKS}parts:\n  - { id: head, group: head, label: Head, archive: a.dat }\n`, /declared together/);
  });

  it("refuses a part in a group nothing declares", () => {
    refuses(CASSIDY.replace("    group: voice\n    label: Joey", "    group: vioce\n    label: Joey"), /"vioce"/);
  });

  it("refuses a part id repeated anywhere in the manifest", () => {
    refuses(CASSIDY.replace("id: voice-tom", "id: voice-joey"), /"voice-joey" twice/);
  });

  it("refuses a part id that could not be recorded", () => {
    refuses(CASSIDY.replace("id: voice-tom", "id: Voice Tom"), /is not an id/);
  });

  it("refuses a needs naming a part that does not exist", () => {
    refuses(CASSIDY.replace("needs: head", "needs: hed"), /needs "hed"/);
  });

  it("refuses parts that need each other, which nothing could ever select", () => {
    refuses(CASSIDY.replace("  - id: head\n", "  - id: head\n    needs: voice-joey\n"), /need each other/);
  });

  it("refuses a part that needs itself", () => {
    refuses(CASSIDY.replace("  - id: head\n", "  - id: head\n    needs: head\n"), /needs itself/);
  });

  it("asks for a newer ZAX when a group picks in a way this version does not implement", () => {
    // Not a misspelling and not ignorable: `pick` decides what lands on disk, so reading an unknown one as
    // `any` would install what the author did not describe. The same answer a later spec gets.
    refuses(CASSIDY.replace("pick: one", "pick: at-least-one"), /newer version of ZAX/);
  });

  it("refuses a part whose asset is not a bare file name, or which names none", () => {
    refuses(CASSIDY.replace("archive: cassidy_head.dat", "archive: ../cassidy_head.dat"), /not a file name/);
    refuses(CASSIDY.replace("    archive: cassidy_head.dat\n", ""), /must be text/);
  });

  it("confines a part's entries the way the mod's own are", () => {
    refuses(CASSIDY.replace("entries: [cassidy_head.dat]", 'entries: ["../rpu.dat"]'), /leaves the game directory/);
  });
});

describe("parts and the mod's own entries", () => {
  it("refuses a manifest declaring both, since each part declares what it puts in mods/", () => {
    expect(() => parsed(`${CASSIDY}entries: [cassidy.dat]\n`)).toThrow(/"entries" and "parts"/);
  });
});

/** RPU as it would publish itself: an Inno installer on Windows, a script beside a zip everywhere else. */
const RPU = `spec: 1
id: rpu
name: Fallout 2 Restoration Project, updated
version: "2.4.34"
game: fallout2
type: base
becomes: fallout2rpu
conflicts:
  - present: [up-changelog.txt]
    absent: [rp-changelog.txt]
    reason: RPU cannot be installed over killap's Unofficial Patch.
installer.windows.asset: rpu_v2.4.34.exe
installer.windows.built-with: inno
installer.other.asset: rpu_v2.4.34.zip
installer.other.run: rpu-install.sh
`;

describe("a base mod's manifest", () => {
  const refuses = (text: string, cause: RegExp) => expect(() => parsed(text)).toThrow(cause);

  it("reads the installer per platform, each route with what only it carries", () => {
    const manifest = parsed(RPU);
    expect(manifest.type).toBe("base");
    expect(manifest.becomes).toBe("fallout2rpu");
    // A base mod installs on a vanilla game and nowhere else unless it says otherwise - the direction both
    // upstream scripts enforce themselves, and the opposite of a stacking mod's "anywhere".
    expect(manifest.installOn).toEqual(["fallout2"]);
    expect(manifest.installer?.other).toEqual({ asset: "rpu_v2.4.34.zip", run: "rpu-install.sh" });
    expect(manifest.installer?.windows).toEqual({ asset: "rpu_v2.4.34.exe", builtWith: "inno" });
  });

  it("keeps a stacking mod's defaults where a base mod's differ", () => {
    // The type is the only field that decides this, so the two are asserted against one another.
    expect(parsed(FO2TWEAKS).installOn).toBeUndefined();
    expect(parsed(FO2TWEAKS).installer).toBeUndefined();
  });

  it("requires an installer of a base mod, and refuses one anywhere else", () => {
    refuses(RPU.replace(/installer\.[\s\S]*$/, ""), /names no "installer"/);
    refuses(`${FO2TWEAKS}installer.other.run: go.sh\n`, /belongs to a base mod/);
  });

  it("requires becomes to name a game type this version can detect", () => {
    refuses(RPU.replace("becomes: fallout2rpu", "becomes: fallout9"), /newer version of ZAX/);
    refuses(RPU.replace("becomes: fallout2rpu\n", ""), /"becomes"/);
    // A stacking mod becomes nothing: the field would be a claim it cannot make good on.
    refuses(`${FO2TWEAKS}becomes: fallout2rpu\n`, /belongs to a base mod/);
  });

  it("asks for a newer ZAX when the installer needs something this version cannot run", () => {
    // Both decide what ZAX executes, and each way of driving an installer is its own: reading an unknown
    // platform key as "not mine" would run the other platform's installer, and an unknown toolkit would be
    // driven with Inno's own switches, which another one reads as file names or as nothing at all.
    refuses(RPU.replace("built-with: inno", "built-with: nsis"), /newer version of ZAX/);
    refuses(RPU.replace("installer.other.", "installer.haiku."), /newer version of ZAX/);
  });

  it("refuses an installer that runs something outside what its payload deploys", () => {
    refuses(RPU.replace("run: rpu-install.sh", "run: ../rpu-install.sh"), /leaves the game directory/);
  });

  it("takes a route that names no asset, leaving the release to supply it", () => {
    // Upstream's installer assets carry the version in their names, and the release is what knows it. A
    // manifest that leaves the name out is written once instead of edited before every tag.
    const unnamed = RPU.replace(/^installer\.\w+\.asset: .*\n/gm, "");
    const manifest = parsed(unnamed);
    expect(manifest.installer?.windows).toEqual({ builtWith: "inno" });
    expect(manifest.installer?.other).toEqual({ run: "rpu-install.sh" });
  });

  it("still holds a named asset to being a file name", () => {
    refuses(
      RPU.replace("installer.windows.asset: rpu_v2.4.34.exe", "installer.windows.asset: builds/rpu.exe"),
      /is not a file name/,
    );
  });

  it("refuses a Windows route that describes what its installer offers, which is the installer's to say", () => {
    // Retired from the format rather than parsed and ignored: a manifest carrying this list was written
    // expecting ZAX to act on it, and accepting it quietly would install something other than it describes.
    refuses(`${RPU}installer.windows.components: []\n`, /unknown field "installer.windows.components"/);
  });
});

/** Fallout et tu as it would publish itself: a base mod that creates its install rather than delegating one. */
const FO1IN2 = `spec: 1
id: fo1in2
name: Fallout et tu
version: "1.16.3771"
game: fallout2
type: base
becomes: fo1in2
archive: Fallout1in2.zip
creates.directory: Fallout1in2
inputs:
  - id: fallout1
    label: Your Fallout 1 folder
    help: The folder holding Fallout 1's MASTER.DAT.
    holds: master.dat
extract-dat.from: fallout1
extract-dat.list: undat_files.txt
extract-dat.into: data
`;

describe("a mod that creates an install", () => {
  const refuses = (text: string, cause: RegExp) => expect(() => parsed(text)).toThrow(cause);

  it("reads what it creates, what it asks for, and what it unpacks", () => {
    const manifest = parsed(FO1IN2);
    expect(manifest.creates).toEqual({ directory: "Fallout1in2" });
    expect(manifest.inputs).toEqual([
      {
        id: "fallout1",
        label: "Your Fallout 1 folder",
        help: "The folder holding Fallout 1's MASTER.DAT.",
        holds: "master.dat",
      },
    ]);
    expect(manifest.extractDat).toEqual({ from: "fallout1", list: "undat_files.txt", into: "data" });
    // The type it becomes is the created install's, not this one's - the host stays exactly what it was.
    expect(manifest.becomes).toBe("fo1in2");
  });

  it("installs anywhere, where a delegated base mod installs on vanilla alone", () => {
    // The two defaults differ because the installs do: a delegated one transforms the directory, and this one
    // writes only inside the directory it makes, so what the host already is does not matter to it.
    expect(parsed(FO1IN2).installOn).toBeUndefined();
    expect(parsed(RPU).installOn).toEqual(["fallout2"]);
  });

  it("requires a base mod to name exactly one of installer and creates", () => {
    refuses(`${FO1IN2}installer.other.run: go.sh\n`, /both/);
    refuses(FO1IN2.replace(/creates\.[\s\S]*$/, ""), /names no "installer"/);
  });

  it("refuses what it creates, asks for, or unpacks anywhere but a base mod", () => {
    refuses(`${FO2TWEAKS}creates.directory: Elsewhere\n`, /belongs to a base mod/);
    refuses(`${FO2TWEAKS}inputs:\n  - { id: a, label: A, holds: master.dat }\n`, /creates an install/);
    refuses(`${RPU}extract-dat.from: a\nextract-dat.list: l.txt\nextract-dat.into: data\n`, /creates an install/);
  });

  it("confines the created directory to one segment of the install it sits in", () => {
    refuses(FO1IN2.replace("directory: Fallout1in2", "directory: ../Fallout1in2"), /leaves the game directory/);
    refuses(FO1IN2.replace("directory: Fallout1in2", "directory: /opt/fo1in2"), /leaves the game directory/);
    refuses(FO1IN2.replace("directory: Fallout1in2", "directory: games/Fallout1in2"), /one folder/);
  });

  it("requires the extraction to name an input the manifest declares", () => {
    refuses(FO1IN2.replace("from: fallout1", "from: fallout2"), /"fallout2", which this mod does not ask for/);
    refuses(FO1IN2.replace(/inputs:[\s\S]*?holds: master\.dat\n/, ""), /does not ask for/);
  });

  it("keeps the extraction inside the directory it created", () => {
    refuses(FO1IN2.replace("list: undat_files.txt", "list: ../undat_files.txt"), /leaves the game directory/);
    refuses(FO1IN2.replace("into: data", "into: ../data"), /leaves the game directory/);
  });

  it("refuses inputs that could not be asked for or checked", () => {
    refuses(FO1IN2.replace("id: fallout1", "id: Fallout 1"), /is not an id/);
    refuses(FO1IN2.replace("holds: master.dat", "holds: sub/master.dat"), /is not a file name/);
    refuses(FO1IN2.replace(/inputs:[\s\S]*?holds: master\.dat\n/, "inputs: []\n"), /asks for nothing/);
  });

  it("refuses one input asked for twice, which would ask the same question of two answers", () => {
    const twice = FO1IN2.replace(
      "extract-dat.from:",
      "  - { id: fallout1, label: Again, holds: master.dat }\nextract-dat.from:",
    );
    refuses(twice, /names "fallout1" twice/);
  });
});
