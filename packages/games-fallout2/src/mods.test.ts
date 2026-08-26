import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { MemoryPlatform } from "@zax/platform/memory";
import type { Install } from "@zax/core";
import {
  entryName,
  listMods,
  readMods,
  saveMods,
  writeOrder,
  type Mod,
  type ModOwner,
  type ModsSnapshot,
} from "./mods.js";
import { saveRecord } from "./records.js";

const install: Install = { path: "game", type: "fallout2" };

const snapshot = (text: string | undefined, present: string[] = [], owners: ModOwner[] = []): ModsSnapshot => ({
  text,
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

describe("readMods", () => {
  const platform = (files: Record<string, string>) =>
    new MemoryPlatform({ home: "h", config: "h/c", cache: "h/cache", files });

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
    expect(snap).toEqual({ text: undefined, present: [], owners: [] });
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
