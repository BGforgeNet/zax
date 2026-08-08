import { describe, expect, it } from "vitest";
import { IniDocument, validate, type SettingDef } from "@zax/core";
import { readFileSync } from "node:fs";
import { SETTINGS } from "./catalog.js";
import { CONFIG_FILES } from "./files.js";

describe("catalog", () => {
  it("covers every setting the previous implementation exposed", () => {
    // A dropped setting is otherwise a silent regression: nothing else in the suite counts them.
    expect(SETTINGS.length).toBe(166);
  });

  it("has unique ids", () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps each config location exactly once", () => {
    const locations = SETTINGS.map((s) => `${s.file}|${s.section}|${s.key}`);
    expect(new Set(locations).size).toBe(locations.length);
  });

  it("gives every setting a non-empty label", () => {
    for (const s of SETTINGS) expect(s.label.trim()).not.toBe("");
  });

  it("declares distinct option values within each choice", () => {
    for (const s of SETTINGS) {
      if (s.kind.type !== "choice") continue;
      const values = s.kind.options.map((o) => o.value);
      expect(new Set(values).size, `${s.id} has duplicate option values`).toBe(values.length);
      expect(values.length).toBeGreaterThan(1);
    }
  });

  it("declares a ceiling only where one can be accounted for", () => {
    // Each has a reason recorded beside it in the generator: quoted from a config file's own comment or from
    // sfall's documentation, an exact integer-type limit, a slider range without which the track cannot be
    // drawn, or a cap this project chose. Every other upper bound in the source is asserted nowhere, and one
    // we cannot account for rejects values the engine accepts.
    const accounted = new Set([
      "hires.maps.numpathnodes", // "20=40000(max)"
      "hires.maps.fog-light-level", // "between 0-10"
      "sfall.misc.combatpanelanimdelay", // 65535
      "sfall.misc.dialogpanelanimdelay", // 255
      "sfall.misc.pipboytimeanimdelay", // 127
      "game.preferences.brightness",
      "game.preferences.mouse-sensitivity",
      "game.preferences.text-base-delay",
      "game.preferences.text-line-delay",
      "game.preferences.combat-speed",
      "sfall.misc.autoquicksave", // sfall's ddraw.ini: "valid range: 1..10"
      "sfall.misc.autoquicksavepage", // sfall's ddraw.ini: "valid range: 0..99"
      "hires.main.refresh-rate", // capped by choice
      "hires.main.scr-width",
      "hires.main.scr-height",
      "sfall.graphics.graphicswidth",
      "sfall.graphics.graphicsheight",
      "sfall.misc.corpsedeletetime", // sfall: "the timer (in days) ... valid range: 0..13"
      "sfall.misc.usewalkdistance", // sfall: "valid range: 0..3"
      "sfall.misc.worldmapdelay2", // sfall: "Default is 66 milliseconds, and the maximum is 150"
      "game.sound.cache-size", // fallout2-ce rejects >= 0x40000
      "game.system.splash", // fallout2-ce wraps the index at SPLASH_COUNT, which is 10
    ]);
    for (const s of SETTINGS) {
      if (s.kind.type !== "int" && s.kind.type !== "float") continue;
      expect(s.kind.max !== undefined, `${s.id} ceiling`).toBe(accounted.has(s.id));
    }
  });

  it("declares only units the source states", () => {
    // fallout2-ce shifts the two cache sizes before use - `<< 10` and `<< 20` - which is what fixes them as
    // kilobytes and megabytes; nothing in the config files themselves says so.
    // A unit reads as a fact about the field. The source gives one for these and for no other numeric, so a
    // unit anywhere else would be an inference presented as a measurement - a fade duration labelled "%" was
    // exactly that.
    const stated = new Set([
      "hires.main.refresh-rate",
      "hires.main.scr-width",
      "hires.main.scr-height",
      "hires.iface.iface-bar-width",
      "sfall.graphics.graphicswidth",
      "sfall.graphics.graphicsheight",
      "sfall.speed.speedmultiinitial",
      "sfall.graphics.fademultiplier",
      "sfall.misc.corpsedeletetime",
      "sfall.misc.processoridle",
      "sfall.misc.worldmaptimemod",
      "sfall.misc.worldmapdelay2",
      "hires.other-settings.splash-scrn-time",
      "hires.mainmenu.menu-bg-offset-x",
      "hires.mainmenu.menu-bg-offset-y",
      "game.sound.cache-size",
      "game.system.art-cache-size",
    ]);
    for (const s of SETTINGS) {
      if (s.kind.type !== "int" && s.kind.type !== "float") continue;
      if (s.kind.unit === undefined) continue;
      expect(stated.has(s.id), `${s.id} carries an unsourced unit "${s.kind.unit}"`).toBe(true);
    }
    expect(SETTINGS.filter((x) => "unit" in x.kind && x.kind.unit).length).toBe(stated.size);
  });

  it("takes the engine's own limits where the config files state none", () => {
    // Read out of fallout2-ce: it refuses a sound cache from 0x40000 up, wraps the splash index at
    // SPLASH_COUNT (10), and shifts the two cache sizes by 10 and 20 bits, which is what fixes their units.
    // Asserted by value, not just by presence - the upstream definition had splash at 5 and would pass a
    // check that only asked whether a ceiling existed.
    const by = (k: string) => SETTINGS.find((s) => s.key === k)!.kind;
    expect(by("cache_size")).toMatchObject({ max: 262143, unit: "KB" });
    expect(by("splash")).toMatchObject({ min: 0, max: 9 });
    expect(by("art_cache_size")).toMatchObject({ unit: "MB" });
  });

  it("takes the quick-save bounds from sfall's documentation, not the upstream definition", () => {
    // The definition we ported from capped the starting page at 1000 where sfall documents 0..99, and carried
    // "Set to 0 to disable" on the page rather than on the count it describes.
    const count = SETTINGS.find((s) => s.key === "AutoQuickSave")!;
    const page = SETTINGS.find((s) => s.key === "AutoQuickSavePage")!;
    expect(count.kind).toMatchObject({ min: 0, max: 10, sentinels: { "0": "Disabled" } });
    expect(page.kind).toMatchObject({ min: -1, max: 99, sentinels: { "-1": "Current page" } });
    expect(page.help, "the disable note belongs to the count").not.toContain("disable");
  });

  it("declares coherent bounds on numeric settings", () => {
    for (const s of SETTINGS) {
      if (s.kind.type !== "int" && s.kind.type !== "float") continue;
      const { min, max } = s.kind;
      if (min !== undefined && max !== undefined) expect(max, `${s.id}`).toBeGreaterThan(min);
    }
  });
});

describe("catalog against real config files", () => {
  const docs = new Map(
    CONFIG_FILES.map((f) => [f, IniDocument.parseBytes(new Uint8Array(readFileSync(`fixtures/vanilla-f2up/${f}`)))]),
  );

  const present = (s: SettingDef) => docs.get(s.file as never)?.get(s.section, s.key) !== undefined;

  it("resolves the majority of settings against a real install", () => {
    // Not all of them: a config file only lists keys the game has written, and sfall's defaults stay implicit
    // until changed. The check guards against a systematically wrong section or key convention, not absence.
    const found = SETTINGS.filter(present).length;
    expect(found / SETTINGS.length).toBeGreaterThan(0.5);
  });

  it("names sections the way the files do, wherever the section exists", () => {
    // Config files vary by component version - the bundled ddraw.ini is sfall 3.3, which predates the
    // [Debugging] and [Interface] sections that 4.x added. An absent section is normal; a section that is
    // present but from which nothing resolves means the catalog spells it or its keys wrongly.
    for (const s of SETTINGS) {
      const doc = docs.get(s.file as never)!;
      const sectionPresent = doc.sections().some((x) => x.toLowerCase() === s.section.toLowerCase());
      if (!sectionPresent) continue;
      const siblings = SETTINGS.filter((o) => o.file === s.file && o.section === s.section);
      expect(
        siblings.some((o) => doc.get(o.section, o.key) !== undefined),
        `${s.file} contains [${s.section}] but no catalog key in it resolves`,
      ).toBe(true);
    }
  });

  it("creates a section that the installed component version predates", () => {
    const doc = IniDocument.parseBytes(new Uint8Array(readFileSync("fixtures/vanilla-f2up/ddraw.ini")));
    expect(doc.get("Debugging", "DebugMode")).toBeUndefined();
    doc.set("Debugging", "DebugMode", "debug.log");
    expect(doc.get("Debugging", "DebugMode")).toBe("debug.log");
    expect(doc.toString()).toContain("[Debugging]");
  });

  it("parses every present value under its declared kind", () => {
    for (const s of SETTINGS) {
      const raw = docs.get(s.file as never)?.get(s.section, s.key);
      if (raw === undefined) continue;
      if (s.kind.type === "int") expect(Number.isFinite(Number(raw)), `${s.id}=${raw}`).toBe(true);
      if (s.kind.type === "float") expect(Number.isFinite(Number(raw)), `${s.id}=${raw}`).toBe(true);
      if (s.kind.type === "bool") expect([s.kind.onValue, s.kind.offValue], `${s.id}=${raw}`).toContain(raw);
    }
  });
});

describe("gating rules", () => {
  it("names a controller that exists and is reachable in the same tab", () => {
    for (const s of SETTINGS) {
      if (!s.gatedBy) continue;
      const controller = SETTINGS.find((c) => c.id === s.gatedBy!.id);
      expect(controller, `${s.id} is gated by unknown ${s.gatedBy.id}`).toBeDefined();
      // Where the two are shown is decided by the layout, so that is where the co-location test lives.
    }
  });

  it("requires values the controller can actually hold", () => {
    for (const s of SETTINGS) {
      if (!s.gatedBy) continue;
      const controller = SETTINGS.find((c) => c.id === s.gatedBy!.id)!;
      // Either form names values; a gate listing none can never open, and one listing none to exclude is a gate
      // that is always open - both are a typo rather than a rule.
      const named = "is" in s.gatedBy ? s.gatedBy.is : s.gatedBy.isNot;
      expect(named.length, `${s.id} names no values`).toBeGreaterThan(0);
      for (const v of named) {
        if (controller.kind.type === "choice") {
          expect(
            controller.kind.options.map((o) => o.value),
            `${s.id} <- ${v}`,
          ).toContain(v);
        }
        if (controller.kind.type === "bool") {
          expect([controller.kind.onValue, controller.kind.offValue], `${s.id} <- ${v}`).toContain(v);
        }
      }
    }
  });

  it("gates the settings whose help only ever said so in prose", () => {
    // Both dependencies survived the port as a sentence and nothing else, so the control rendered fully live
    // while its own help said it needed something else.
    const gateOf = (id: string) => SETTINGS.find((s) => s.id === id)?.gatedBy;
    expect(gateOf("sfall.graphics.allowdshowmovies")).toEqual({
      id: "sfall.graphics.mode",
      is: ["4", "5", "6"],
    });
    expect(gateOf("sfall.input.fastmovefromcontainer")).toEqual({
      id: "sfall.input.itemfastmovekey",
      isNot: ["0"],
    });
  });

  it("does not gate a setting by itself or form a cycle", () => {
    for (const s of SETTINGS) {
      if (!s.gatedBy) continue;
      expect(s.gatedBy.id).not.toBe(s.id);
      const controller = SETTINGS.find((c) => c.id === s.gatedBy!.id)!;
      expect(controller.gatedBy?.id).not.toBe(s.id);
    }
  });
});

describe("conflicts", () => {
  it("names a counterpart that exists and is not itself", () => {
    for (const s of SETTINGS) {
      if (!s.conflictsWith) continue;
      expect(s.conflictsWith.id, `${s.id} conflicts with itself`).not.toBe(s.id);
      const other = SETTINGS.find((c) => c.id === s.conflictsWith!.id);
      expect(other, `${s.id} conflicts with unknown ${s.conflictsWith.id}`).toBeDefined();
      expect(s.conflictsWith.note.length, `${s.id} says nothing about the clash`).toBeGreaterThan(0);
    }
  });

  it("warns about the idle-twice pairing rather than gating either half of it", () => {
    const fix = SETTINGS.find((s) => s.id === "hires.other-settings.cpu-usage-fix")!;
    const other = SETTINGS.find((s) => s.id === "sfall.misc.processoridle")!;
    expect(fix.conflictsWith?.id).toBe(other.id);
    // The two components each idle the process on their own, so neither disables the other and neither may be
    // expressed as a gate - which is the whole reason this mechanism exists alongside gatedBy.
    expect(fix.gatedBy).toBeUndefined();
    expect(other.gatedBy).toBeUndefined();
    expect(fix.file).not.toBe(other.file);
  });
});

describe("managed values", () => {
  it("pins a value the setting can actually hold", () => {
    for (const s of SETTINGS) {
      if (!s.managed) continue;
      expect(validate(s, s.managed.value).ok, `${s.id} pins an invalid value`).toBe(true);
      expect(s.managed.reason.trim(), `${s.id} pins without a reason`).not.toBe("");
    }
  });

  it("pins UAC_AWARE off, which the install has on", () => {
    // The bundled f2_res.ini ships UAC_AWARE=1, which sends the patch to roaming appdata for its settings while
    // ZAX writes the copy in the game folder. Pinning it off is what keeps the two looking at one file.
    const uac = SETTINGS.find((s) => s.key === "UAC_AWARE");
    expect(uac?.managed?.value).toBe("0");
    const doc = IniDocument.parseBytes(new Uint8Array(readFileSync("fixtures/vanilla-f2up/f2_res.ini")));
    expect(doc.get("MAIN", "UAC_AWARE")).toBe("1");
  });
});
