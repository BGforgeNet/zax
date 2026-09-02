import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MemoryPlatform } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import {
  entryName,
  listMods,
  orderFormatOf,
  previewOrderSwap,
  readMods,
  saveMods,
  swapOrderTo,
  writeOrder,
  type Mod,
  type ModOwner,
  type ModsSnapshot,
} from "./mods.js";
import { saveRecord } from "./records.js";

const install: Install = { path: "game", type: "fallout2" };

const snapshot = (text: string | undefined, present: string[] = [], owners: ModOwner[] = []): ModsSnapshot => ({
  text,
  format: text === undefined ? "sfall" : orderFormatOf(text),
  present: present.map((name) => ({ name, kind: name.includes(".") ? "dat" : "folder" })),
  owners,
});

const shown = (mods: readonly Mod[]) => mods.map((m) => `${m.enabled ? "+" : "-"}${m.name}`);

describe("entryName", () => {
  it("reads a plain entry", () => {
    expect(entryName("rpu.dat")).toBe("rpu.dat");
  });

  it("stops at a comment, whichever marker starts it", () => {
    expect(entryName("rpu.dat ; the good one")).toBe("rpu.dat");
    expect(entryName("rpu.dat # the good one")).toBe("rpu.dat");
  });

  it("normalizes separators and drops leading ones, as the loader does", () => {
    expect(entryName("  patches/extra.dat  ")).toBe("patches\\extra.dat");
    expect(entryName("\\\\rpu.dat")).toBe("rpu.dat");
  });

  it("refuses a path that could leave the game folder", () => {
    expect(entryName("..\\..\\windows\\system32")).toBeNull();
    expect(entryName("C:\\mods\\rpu.dat")).toBeNull();
  });

  it("names nothing for a blank or comment-only line", () => {
    expect(entryName("")).toBeNull();
    expect(entryName("   ")).toBeNull();
    expect(entryName("; just a note")).toBeNull();
  });
});

describe("listMods", () => {
  it("keeps the file's order and marks what is on disk", () => {
    const mods = listMods(snapshot("fo1_base\nrpu.dat\n", ["rpu.dat", "fo1_base"]));
    expect(shown(mods)).toEqual(["+fo1_base", "+rpu.dat"]);
    expect(mods.map((m) => m.kind)).toEqual(["folder", "dat"]);
  });

  it("reads a commented line naming a real mod as that mod, disabled", () => {
    expect(shown(listMods(snapshot("; rpu.dat\nextra.dat\n", ["rpu.dat", "extra.dat"])))).toEqual([
      "-rpu.dat",
      "+extra.dat",
    ]);
  });

  it("leaves a comment that names nothing on disk as prose", () => {
    expect(shown(listMods(snapshot("; the ones below are optional\nrpu.dat\n", ["rpu.dat"])))).toEqual(["+rpu.dat"]);
  });

  it("shows an entry whose file is gone rather than dropping it silently", () => {
    const mods = listMods(snapshot("gone.dat\n", []));
    expect(shown(mods)).toEqual(["+gone.dat"]);
    expect(mods[0]?.kind).toBe("missing");
  });

  it("appends what the folder holds and the file never named, disabled", () => {
    expect(shown(listMods(snapshot("rpu.dat\n", ["rpu.dat", "unheard_of.dat"])))).toEqual([
      "+rpu.dat",
      "-unheard_of.dat",
    ]);
  });

  it("keeps the last of two lines naming the same mod, as the loader does", () => {
    expect(shown(listMods(snapshot("rpu.dat\nextra.dat\nrpu.dat\n", ["rpu.dat", "extra.dat"])))).toEqual([
      "+extra.dat",
      "+rpu.dat",
    ]);
  });

  it("matches a name against the folder however it is cased", () => {
    expect(listMods(snapshot("RPU.DAT\n", ["rpu.dat"]))[0]?.kind).toBe("dat");
  });

  it("names the mod a recorded entry belongs to, and leaves the rest unowned", () => {
    const owners = [{ name: "FO2tweaks", files: ["mods/fo2tweaks.dat", "mods/fo2tweaks.ini"] }];
    const mods = listMods(snapshot("rpu.dat\nfo2tweaks.dat\n", ["rpu.dat", "fo2tweaks.dat"], owners));
    expect(mods.map((mod) => mod.owner)).toEqual([undefined, "FO2tweaks"]);
  });

  it("names one the order file never mentions, however either side spells it", () => {
    const owners = [{ name: "FO2tweaks", files: ["Mods/fo2tweaks.dat"] }];
    expect(listMods(snapshot(undefined, ["FO2tweaks.dat"], owners))[0]?.owner).toBe("FO2tweaks");
  });

  it("names the folder a mod's files sit in, which is the entry the order file carries", () => {
    const owners = [{ name: "Hero Appearance", files: ["mods/hero_look/art/critters/hmjmps.frm"] }];
    expect(listMods(snapshot("hero_look\n", ["hero_look"], owners))[0]?.owner).toBe("Hero Appearance");
  });

  it("leaves an entry two mods both claim unowned, rather than crediting one of them", () => {
    const owners = [
      { name: "One", files: ["mods/patches/one.dat"] },
      { name: "Two", files: ["mods/patches/two.dat"] },
    ];
    const mods = listMods(snapshot("patches\npatches\\one.dat\n", ["patches", "patches\\one.dat"], owners));
    expect(mods.map((mod) => mod.owner)).toEqual([undefined, "One"]);
  });
});

describe("writeOrder", () => {
  const order = (text: string, mods: readonly Mod[]) => writeOrder(text, mods);

  it("writes an unchanged list back byte for byte", () => {
    const text = "fo1_base\nrpu.dat ; the good one\n";
    expect(order(text, listMods(snapshot(text, ["fo1_base", "rpu.dat"])))).toBe(text);
  });

  it("comments a line out in place, keeping its position and its note", () => {
    const text = "fo1_base\nrpu.dat ; the good one\n";
    const mods = listMods(snapshot(text, ["fo1_base", "rpu.dat"])).map((m) =>
      m.name === "rpu.dat" ? { ...m, enabled: false } : m,
    );
    expect(order(text, mods)).toBe("fo1_base\n; rpu.dat ; the good one\n");
  });

  it("uncomments a line to enable it", () => {
    const text = "; rpu.dat\n";
    const mods = listMods(snapshot(text, ["rpu.dat"])).map((m) => ({ ...m, enabled: true }));
    expect(order(text, mods)).toBe("rpu.dat\n");
  });

  it("writes a mod the file never named", () => {
    const text = "rpu.dat\n";
    const mods = listMods(snapshot(text, ["rpu.dat", "extra.dat"]));
    expect(order(text, mods)).toBe("rpu.dat\n; extra.dat\n");
  });

  it("carries a note directly above an entry with it when the entry moves", () => {
    const text = "rpu.dat\n; needs the patch\nextra.dat\n";
    const mods = listMods(snapshot(text, ["rpu.dat", "extra.dat"]));
    expect(order(text, [mods[1]!, mods[0]!])).toBe("; needs the patch\nextra.dat\nrpu.dat\n");
  });

  it("leaves a header block at the top, whether or not a blank line sets it off", () => {
    const spaced = "; ZAX writes this file\n\nextra.dat\nrpu.dat\n";
    const tight = "; ZAX writes this file\nextra.dat\nrpu.dat\n";
    const reversed = (text: string) => {
      const mods = listMods(snapshot(text, ["extra.dat", "rpu.dat"]));
      return order(text, [mods[1]!, mods[0]!]);
    };
    expect(reversed(spaced)).toBe("; ZAX writes this file\n\nrpu.dat\nextra.dat\n");
    // The header of a file the loader wrote has no blank line under it, and it still belongs to the file.
    expect(reversed(tight)).toBe("; ZAX writes this file\nrpu.dat\nextra.dat\n");
  });

  it("preserves the file's line terminator", () => {
    const text = "extra.dat\r\nrpu.dat\r\n";
    const mods = listMods(snapshot(text, ["extra.dat", "rpu.dat"]));
    expect(order(text, [mods[1]!, mods[0]!])).toBe("rpu.dat\r\nextra.dat\r\n");
  });

  it("leaves a file with no final newline without one", () => {
    const text = "extra.dat\nrpu.dat";
    expect(order(text, listMods(snapshot(text, ["extra.dat", "rpu.dat"])))).toBe(text);
  });

  it("terminates a line that was the last and now is not", () => {
    const text = "extra.dat\nrpu.dat";
    const mods = listMods(snapshot(text, ["extra.dat", "rpu.dat"]));
    expect(order(text, [mods[1]!, mods[0]!])).toBe("rpu.dat\nextra.dat");
  });

  it("writes an order into an install that had no file", () => {
    expect(writeOrder(undefined, listMods(snapshot(undefined, ["rpu.dat"])))).toBe("; rpu.dat\n");
  });

  /*
    The file is rewritten whole rather than one line at a time, so what matters is that a second pass changes
    nothing: any line the first pass moves has to land where the next parse puts it back.
  */
  it("is stable: writing what it wrote produces the same file", () => {
    const names = fc.constantFrom("rpu.dat", "extra.dat", "fo1_base", "patches\\deep.dat");
    const line = fc.oneof(
      names,
      names.map((n) => `; ${n}`),
      fc.constantFrom("", "   ", "; a note", "# another note", "..\\escape.dat"),
    );
    fc.assert(
      fc.property(fc.array(line, { maxLength: 12 }), fc.constantFrom("\n", "\r\n"), (bodies, eol) => {
        const text = bodies.map((b) => b + eol).join("");
        const present = ["rpu.dat", "extra.dat", "fo1_base", "patches\\deep.dat"];
        const once = writeOrder(text, listMods(snapshot(text, present)));
        const twice = writeOrder(once, listMods(snapshot(once, present)));
        expect(twice).toBe(once);
      }),
    );
  });

  it("never drops a comment's text", () => {
    const text = "; keep me\nrpu.dat\n\n; and me\n\nextra.dat\n; and me too\n";
    const mods = listMods(snapshot(text, ["rpu.dat", "extra.dat"]));
    const written = order(text, [mods[1]!, mods[0]!]);
    for (const note of ["; keep me", "; and me", "; and me too"]) expect(written).toContain(note);
  });
});

/*
  A real Fission file: the two-line header it writes, then one record per mod. Both matter to the sniff - an
  empty Fission list is nothing but that header, and its second line carries a pipe inside a comment.
*/
const FISSION_ORDER =
  "# FISSION mods_order.txt (pipe-separated)\n" +
  "# Format: enabled|datName|internalName|displayName|author|description|dependencies|iconIndex\n" +
  "1|combat_speed|combat_speed|Combat Speed|Some Author|Does a thing| |7\n";

const SFALL_ORDER = "; Loaded in this order\nrpu.dat\n; extra.dat\n";

describe("orderFormatOf", () => {
  it("reads a path-per-line file as sfall's", () => {
    expect(orderFormatOf(SFALL_ORDER)).toBe("sfall");
  });

  it("reads a pipe record as Fission's", () => {
    expect(orderFormatOf(FISSION_ORDER)).toBe("fission");
  });

  /* An empty Fission list is header and nothing else, and the pipe in it sits inside a comment. */
  it("reads Fission's header alone as Fission's, with no records under it", () => {
    expect(orderFormatOf(FISSION_ORDER.split("\n").slice(0, 2).join("\n") + "\n")).toBe("fission");
  });

  /*
    Ambiguous, and sfall is the safe way round: sfall's is what ZAX writes, and Fission truncates and rebuilds
    whatever it finds anyway, so guessing sfall costs a rebuild where guessing Fission would file an sfall list
    under the wrong name.
  */
  it("reads an empty or comment-only file as sfall's", () => {
    expect(orderFormatOf("")).toBe("sfall");
    expect(orderFormatOf("; nothing here\n\n")).toBe("sfall");
  });
});

describe("swapOrderTo", () => {
  const platform = (files: Record<string, string>) =>
    new MemoryPlatform({ home: "h", config: "h/c", cache: "h/cache", files });

  const at = async (p: MemoryPlatform, path: string) =>
    (await p.fs.stat(path)) === null ? null : new TextDecoder("latin1").decode(await p.fs.read(path));

  const SLOT = "game/mods/mods_order.txt";
  const SFALL_SIDE = "game/mods/mods_order.sfall.txt";
  const FISSION_SIDE = "game/mods/mods_order.fission.txt";

  it("files the sfall list aside and clears the slot for an engine that has none yet", async () => {
    const p = platform({ [SLOT]: SFALL_ORDER });
    await swapOrderTo(p, "game", "fission");
    expect(await at(p, SFALL_SIDE)).toBe(SFALL_ORDER);
    expect(await at(p, SLOT), "left for Fission to write its own").toBeNull();
  });

  it("puts a kept list back when there is one", async () => {
    const p = platform({ [SLOT]: SFALL_ORDER, [FISSION_SIDE]: FISSION_ORDER });
    await swapOrderTo(p, "game", "fission");
    expect(await at(p, SLOT)).toBe(FISSION_ORDER);
    expect(await at(p, SFALL_SIDE)).toBe(SFALL_ORDER);
  });

  /* The way back, which is the half that decides whether anything was actually kept. */
  it("swaps back, so a round trip through Fission returns the sfall list byte for byte", async () => {
    const p = platform({ [SLOT]: SFALL_ORDER });
    await swapOrderTo(p, "game", "fission");
    await p.fs.write(SLOT, new TextEncoder().encode(FISSION_ORDER));
    await swapOrderTo(p, "game", "sfall");
    expect(await at(p, SLOT)).toBe(SFALL_ORDER);
    expect(await at(p, FISSION_SIDE), "and Fission's own list was kept on the way out").toBe(FISSION_ORDER);
  });

  it("does nothing when the slot already holds the format wanted", async () => {
    const p = platform({ [SLOT]: SFALL_ORDER });
    await swapOrderTo(p, "game", "sfall");
    expect(await at(p, SLOT)).toBe(SFALL_ORDER);
    expect(await at(p, SFALL_SIDE), "no sidecar is written until a swap actually moves the slot").toBeNull();
  });

  /* Keyed on the file rather than on a memory of who ran last, so a repeat is free and an interrupted one heals. */
  it("is idempotent", async () => {
    const p = platform({ [SLOT]: SFALL_ORDER, [FISSION_SIDE]: FISSION_ORDER });
    await swapOrderTo(p, "game", "fission");
    await swapOrderTo(p, "game", "fission");
    await swapOrderTo(p, "game", "fission");
    expect(await at(p, SLOT)).toBe(FISSION_ORDER);
    expect(await at(p, SFALL_SIDE)).toBe(SFALL_ORDER);
  });

  it("restores a kept list into a folder whose slot is gone", async () => {
    const p = platform({ [FISSION_SIDE]: FISSION_ORDER, "game/mods/mod_combat_speed.dat": "" });
    await swapOrderTo(p, "game", "fission");
    expect(await at(p, SLOT)).toBe(FISSION_ORDER);
  });

  it("leaves an install with neither a slot nor a sidecar alone", async () => {
    const p = platform({ "game/fallout2.exe": "" });
    await swapOrderTo(p, "game", "fission");
    expect(await at(p, SLOT)).toBeNull();
    expect(await at(p, FISSION_SIDE)).toBeNull();
  });
});

describe("previewOrderSwap", () => {
  const platform = (files: Record<string, string>) =>
    new MemoryPlatform({ home: "h", config: "h/c", cache: "h/cache", files });

  const FOLDER = {
    "game/mods/rpu.dat": "",
    "game/mods/hero_appearance/art/x.frm": "",
    "game/mods/mod_combat_speed.dat": "",
  };

  it("answers with nothing where the engine reads what is already there", async () => {
    const p = platform({ ...FOLDER, "game/mods/mods_order.txt": SFALL_ORDER });
    expect(await previewOrderSwap(p, "game", "sfall")).toBeNull();
  });

  /*
    No list of its own yet, so its first run scans the folder and turns on everything it finds - which for
    Fission is the `mod_` dats and nothing else. That is the honest answer to "what will load", and it is the
    run where a user is most likely to be surprised.
  */
  it("says what a first Fission run would load, from its folder scan", async () => {
    const p = platform({ ...FOLDER, "game/mods/mods_order.txt": "rpu.dat\nhero_appearance\n" });
    const swap = await previewOrderSwap(p, "game", "fission");
    expect(swap?.from).toBe("sfall");
    expect(swap?.to).toBe("fission");
    expect(swap?.losing, "in the order the file loads them").toEqual(["rpu.dat", "hero_appearance"]);
    expect(swap?.gaining).toEqual(["mod_combat_speed.dat"]);
  });

  it("reads a kept Fission list rather than assuming its scan, where one is filed here", async () => {
    const p = platform({
      ...FOLDER,
      "game/mods/mods_order.txt": "rpu.dat\n",
      "game/mods/mods_order.fission.txt":
        "# FISSION mods_order.txt (pipe-separated)\n0|combat_speed|combat_speed|Combat Speed| | | |0\n",
    });
    const swap = await previewOrderSwap(p, "game", "fission");
    expect(swap?.losing).toEqual(["rpu.dat"]);
    expect(swap?.gaining, "the kept list has it switched off").toEqual([]);
  });

  /* The direction the user sees on the way back, and the one that only exists because the read stopped swapping. */
  it("says what switching back to sfall restores", async () => {
    const p = platform({
      ...FOLDER,
      "game/mods/mods_order.txt": FISSION_ORDER,
      "game/mods/mods_order.sfall.txt": "rpu.dat\nhero_appearance\n",
    });
    const swap = await previewOrderSwap(p, "game", "sfall");
    expect(swap?.from).toBe("fission");
    expect(swap?.to).toBe("sfall");
    expect(swap?.losing).toEqual(["mod_combat_speed.dat"]);
    expect(swap?.gaining).toEqual(["rpu.dat", "hero_appearance"]);
  });

  /* Named only if it is actually there: a list may name a mod whose file has since gone. */
  it("names nothing the folder does not hold", async () => {
    const p = platform({ "game/mods/mods_order.txt": "gone.dat\n", "game/mods/mod_combat_speed.dat": "" });
    const swap = await previewOrderSwap(p, "game", "fission");
    expect(swap?.losing).toEqual([]);
    expect(swap?.gaining).toEqual(["mod_combat_speed.dat"]);
  });
});

describe("readMods", () => {
  const platform = (files: Record<string, string>) =>
    new MemoryPlatform({ home: "h", config: "h/c", cache: "h/cache", files });

  /*
    Reports the format and touches nothing. A read that rewrote the file would race an engine ZAX had just
    started for the very file it is reading, and would rewrite the user's mod order because they opened a tab.
  */
  it("says which format it found and leaves the file exactly as it was", async () => {
    const p = platform({
      "game/mods/mods_order.txt": FISSION_ORDER,
      "game/mods/mods_order.sfall.txt": SFALL_ORDER,
      "game/mods/rpu.dat": "",
    });
    const snap = await readMods(p, install);
    expect(snap.format).toBe("fission");
    expect(snap.text).toBe(FISSION_ORDER);
    const after = new TextDecoder("latin1").decode(await p.fs.read("game/mods/mods_order.txt"));
    expect(after, "untouched").toBe(FISSION_ORDER);
  });

  it("calls a folder with no order file at all sfall's, which is what ZAX can edit", async () => {
    const snap = await readMods(platform({ "game/mods/rpu.dat": "" }), install);
    expect(snap.format).toBe("sfall");
  });

  /*
    An install that never meets Fission never grows one of these. The swap writes a sidecar only when it moves
    the slot, and the slot only moves when the format wanted differs from the format there - so reading, saving
    and launching an sfall-only folder leaves the folder exactly as it was.
  */
  it("puts no sidecar in a folder that has only ever been sfall's", async () => {
    const p = platform({ "game/mods/mods_order.txt": SFALL_ORDER, "game/mods/rpu.dat": "" });
    await readMods(p, install);
    await readMods(p, install);
    const listed = (await p.fs.list("game/mods")).map((entry) => entry.name).toSorted();
    expect(listed).toEqual(["mods_order.txt", "rpu.dat"]);
  });

  /* The sidecars sit in the folder it lists, and must not be offered as mods to load. */
  it("does not take a sidecar for a mod", async () => {
    const snap = await readMods(
      platform({
        "game/mods/mods_order.txt": SFALL_ORDER,
        "game/mods/mods_order.sfall.txt": SFALL_ORDER,
        "game/mods/mods_order.fission.txt": FISSION_ORDER,
        "game/mods/rpu.dat": "",
      }),
      install,
    );
    expect(snap.present.map((e) => e.name)).toEqual(["rpu.dat"]);
  });

  it("reads the file and the folder beside it", async () => {
    const snap = await readMods(
      platform({
        "game/mods/mods_order.txt": "rpu.dat\n",
        "game/mods/rpu.dat": "",
        "game/mods/extra.dat": "",
      }),
      install,
    );
    expect(snap.text).toBe("rpu.dat\n");
    expect(snap.present.map((e) => e.name)).toEqual(["extra.dat", "rpu.dat"]);
  });

  it("answers with nothing for an install that has no mods folder", async () => {
    const snap = await readMods(platform({ "game/fallout2.exe": "" }), install);
    expect(snap).toEqual({ text: undefined, format: "sfall", present: [], owners: [] });
  });

  it("ignores the order file and loose clutter when listing what could load", async () => {
    const snap = await readMods(
      platform({ "game/mods/mods_order.txt": "", "game/mods/readme.txt": "", "game/mods/rpu.dat": "" }),
      install,
    );
    expect(snap.present.map((e) => e.name)).toEqual(["rpu.dat"]);
  });

  it("resolves a nested entry the folder listing never reaches", async () => {
    const snap = await readMods(
      platform({ "game/mods/mods_order.txt": "patches/extra.dat\n", "game/mods/patches/extra.dat": "" }),
      install,
    );
    expect(snap.present).toContainEqual({ name: "patches\\extra.dat", kind: "dat" });
  });

  it("takes a folder in the mods directory for a mod", async () => {
    const snap = await readMods(platform({ "game/mods/fo1_base/master.dat": "" }), install);
    expect(snap.present).toEqual([{ name: "fo1_base", kind: "folder" }]);
  });

  it("carries what the record says it installed, an unfinished install included", async () => {
    const held = platform({ "game/mods/fo2tweaks.dat": "" });
    await saveRecord(held, {
      path: "game",
      mods: [
        {
          id: "fo2tweaks",
          version: "14.7",
          complete: false,
          files: ["mods/fo2tweaks.dat"],
          manifest: 'spec: 1\nid: fo2tweaks\nname: FO2tweaks\nversion: "14.7"\ngame: fallout2\n',
          shipped: {},
        },
      ],
    });
    const snap = await readMods(held, install);
    expect(snap.owners).toEqual([{ name: "FO2tweaks", files: ["mods/fo2tweaks.dat"] }]);
  });
});

describe("saveMods", () => {
  const seeded = () =>
    new MemoryPlatform({
      home: "h",
      config: "h/c",
      cache: "h/cache",
      files: { "game/mods/mods_order.txt": "rpu.dat\nextra.dat\n", "game/mods/rpu.dat": "", "game/mods/extra.dat": "" },
    });

  const read = async (platform: MemoryPlatform) =>
    new TextDecoder().decode(await platform.fs.read("game/mods/mods_order.txt"));

  it("writes the order and copies nothing aside", async () => {
    const platform = seeded();
    const before = await readMods(platform, install);
    const mods = [...listMods(before)].reverse();

    const outcome = await saveMods(platform, { installPath: "game", original: before.text, mods });
    expect(outcome).toEqual({ ok: true, files: ["mods/mods_order.txt"] });
    expect(await read(platform)).toBe("extra.dat\nrpu.dat\n");
    // An install writes the order through here too, and unwinds from the journal rather than from a copy.
    expect(platform.allFiles()).toEqual(["game/mods/extra.dat", "game/mods/mods_order.txt", "game/mods/rpu.dat"]);
  });

  it("refuses a file that changed since it was read, and writes nothing", async () => {
    const platform = seeded();
    const before = await readMods(platform, install);
    await platform.fs.write("game/mods/mods_order.txt", new TextEncoder().encode("someone_else.dat\n"));

    const outcome = await saveMods(platform, { installPath: "game", original: before.text, mods: listMods(before) });
    expect(outcome).toEqual({ ok: false, changed: ["mods/mods_order.txt"] });
    expect(await read(platform)).toBe("someone_else.dat\n");
  });

  it("creates the file for an install that never had one", async () => {
    const platform = new MemoryPlatform({
      home: "h",
      config: "h/c",
      cache: "h/cache",
      files: { "game/mods/rpu.dat": "" },
    });
    const before = await readMods(platform, install);
    const outcome = await saveMods(platform, {
      installPath: "game",
      original: before.text,
      mods: listMods(before).map((m) => ({ ...m, enabled: true })),
    });

    expect(outcome).toEqual({ ok: true, files: ["mods/mods_order.txt"] });
    expect(await read(platform)).toBe("rpu.dat\n");
  });
});
