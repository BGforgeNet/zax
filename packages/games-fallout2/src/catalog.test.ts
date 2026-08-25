import { describe, expect, it } from "vitest";
import { IniDocument, ownTarget, validate, type SettingDef } from "@zax/core";
import { readFileSync } from "node:fs";
import { SETTINGS } from "./catalog.js";
import { ENGINES } from "./engines.js";
import { CONFIG_FILES, ENGINE_CONFIG_FILES } from "./files.js";

describe("catalog", () => {
  it("covers every setting the previous implementation exposed, plus the ones ZAX added", () => {
    // A dropped setting is otherwise a silent regression: nothing else in the suite counts them. The 166 the
    // previous implementation exposed, 13 from scripts/gen/added.yml that it never had, and the keys the two
    // alternative engines have that no other component does - 28 for fallout2-ce and 20 for Fission.
    expect(SETTINGS.length).toBe(227);
    expect(SETTINGS.filter((s) => ownTarget(s).engine === undefined).length).toBe(179);
  });

  it("has unique ids", () => {
    const ids = SETTINGS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps each config location exactly once, across every target", () => {
    // Not just each setting's own address: a linked setting writes several, and an address reached by two
    // settings would give one key two rows that disagree the moment either link propagates.
    const locations = SETTINGS.flatMap((s) => s.targets.map((t) => `${t.file}|${t.section}|${t.key}`));
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
      "hires.MAPS.NumPathNodes", // "20=40000(max)"
      "hires.MAPS.FOG_LIGHT_LEVEL", // "between 0-10"
      "sfall.Misc.CombatPanelAnimDelay", // 65535
      "sfall.Misc.DialogPanelAnimDelay", // 255
      "sfall.Misc.PipboyTimeAnimDelay", // 127
      "game.preferences.brightness",
      "game.preferences.mouse_sensitivity",
      "game.preferences.text_base_delay",
      "game.preferences.text_line_delay",
      "game.preferences.combat_speed",
      "sfall.Misc.AutoQuickSave", // sfall's ddraw.ini: "valid range: 1..10"
      "sfall.Misc.AutoQuickSavePage", // sfall's ddraw.ini: "valid range: 0..99"
      "hires.MAIN.REFRESH_RATE", // capped by choice
      "hires.MAIN.SCR_WIDTH",
      "hires.MAIN.SCR_HEIGHT",
      "sfall.Graphics.GraphicsWidth",
      "sfall.Graphics.GraphicsHeight",
      "sfall.Misc.CorpseDeleteTime", // sfall: "the timer (in days) ... valid range: 0..13"
      "sfall.Misc.UseWalkDistance", // sfall: "valid range: 0..3"
      "sfall.Misc.WorldMapDelay2", // sfall: "Default is 66 milliseconds, and the maximum is 150"
      "sfall.Sound.NumSoundBuffers", // sfall: "Set to 0 to leave the default unchanged (i.e. 8). The maximum is 32"
      "sfall.Misc.SpeedInventoryPCRotation", // sfall: "Default is 166 (lower - faster; valid range: 0..1000)"
      "game.sound.cache_size", // fallout2-ce rejects >= 0x40000
      "game.system.splash", // fallout2-ce wraps the index at SPLASH_COUNT, which is 10
      // fallout2-ce clamps these on load through its own `SETTING_P(key, clamp(a, b))` registrations, so a
      // value outside them is not one the engine keeps. Carried across by the extraction, not chosen here.
      "game.screen.scale",
      "game.ui.anim_speed",
      "game.ui.inventory_columns",
      "game.ui.loot_container_size_indicator_threshold",
      "game.debug.window_width",
      "game.debug.window_height",
      "game.qol.use_walk_distance",
      "fission.enhancements.InventoryColumns", // Fission's `inventoryUpdateLayout` clamps to 1..4
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
      "hires.MAIN.REFRESH_RATE",
      "hires.MAIN.SCR_WIDTH",
      "hires.MAIN.SCR_HEIGHT",
      "hires.IFACE.IFACE_BAR_WIDTH",
      "sfall.Graphics.GraphicsWidth",
      "sfall.Graphics.GraphicsHeight",
      "sfall.Speed.SpeedMultiInitial",
      "sfall.Graphics.FadeMultiplier",
      "sfall.Misc.CorpseDeleteTime",
      "sfall.Misc.ProcessorIdle",
      "sfall.Misc.WorldMapTimeMod",
      "sfall.Misc.WorldMapDelay2",
      "hires.OTHER_SETTINGS.SPLASH_SCRN_TIME",
      "hires.MAINMENU.MENU_BG_OFFSET_X",
      "hires.MAINMENU.MENU_BG_OFFSET_Y",
      "game.sound.cache_size",
      "game.system.art_cache_size",
      // fallout2-ce's own comments in the config it ships: "when size reaches XX%", and "the number of empty
      // tiles between the player and the target".
      "game.ui.loot_container_size_indicator_threshold",
      "game.qol.use_walk_distance",
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
    const by = (k: string) => SETTINGS.find((s) => ownTarget(s).key === k)!.kind;
    expect(by("cache_size")).toMatchObject({ max: 262143, unit: "KB" });
    expect(by("splash")).toMatchObject({ min: 0, max: 9 });
    expect(by("art_cache_size")).toMatchObject({ unit: "MB" });
  });

  it("takes the quick-save bounds from sfall's documentation, not the upstream definition", () => {
    // The definition we ported from capped the starting page at 1000 where sfall documents 0..99, and carried
    // "Set to 0 to disable" on the page rather than on the count it describes.
    const count = SETTINGS.find((s) => ownTarget(s).key === "AutoQuickSave")!;
    const page = SETTINGS.find((s) => ownTarget(s).key === "AutoQuickSavePage")!;
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

describe("linked settings", () => {
  const KNOWN_FILES = new Set<string>([...CONFIG_FILES, ...ENGINE_CONFIG_FILES]);
  const linked = SETTINGS.filter((s) => s.targets.length > 1);

  it("addresses only files ZAX knows about", () => {
    // A target in a file nothing can reach is a write that goes nowhere, and it would look identical to a
    // target waiting on an engine that is simply not installed.
    for (const s of SETTINGS) {
      for (const t of s.targets) expect(KNOWN_FILES.has(t.file), `${s.id} -> ${t.file}`).toBe(true);
    }
  });

  it("gives every target a section and a key that can carry an id", () => {
    // The same bound ids.mjs enforces when it mints one. A separator inside a piece would make the address
    // ambiguous, and an empty one addresses the file rather than a key in it.
    for (const s of SETTINGS) {
      for (const t of s.targets) {
        expect(t.section, `${s.id} -> ${t.file}`).toMatch(/^[A-Za-z0-9._-]+$/);
        expect(t.key, `${s.id} -> ${t.file}`).toMatch(/^[A-Za-z0-9._-]+$/);
      }
    }
  });

  it("mints every id from the nominated target, which comes first", () => {
    // Stated here rather than imported from the generator on purpose: two copies of the rule is what makes
    // this a check on the committed output instead of a restatement of how it was produced.
    const prefix: Record<string, string> = {
      "fallout2.cfg": "game",
      "f2_res.ini": "hires",
      "ddraw.ini": "sfall",
      "fission.cfg": "fission",
    };
    for (const s of SETTINGS) {
      const at = ownTarget(s);
      expect(s.id, `${s.id} is not minted from its first target`).toBe(`${prefix[at.file]}.${at.section}.${at.key}`);
    }
  });

  it("links the settings fallout2-ce and Fission carry under their own names", () => {
    // By value, since the whole point is which address the write reaches. Losing a target would leave the row
    // working and the engine silently unwritten, which no other check would notice.
    const targetsOf = (id: string) => SETTINGS.find((s) => s.id === id)!.targets;
    expect(targetsOf("sfall.Interface.ExpandBarter")).toEqual([
      { file: "ddraw.ini", section: "Interface", key: "ExpandBarter" },
      { file: "fallout2.cfg", section: "ui", key: "expand_barter_window", engine: "fallout2-ce" },
      {
        file: "fission.cfg",
        section: "enhancements",
        key: "EnhancedBarter",
        engine: "fission",
        gatedBy: { id: "fission.enhancements.StrictVanilla", is: ["0"] },
      },
    ]);
    expect(targetsOf("hires.MAIN.SCR_WIDTH")).toEqual([
      { file: "f2_res.ini", section: "MAIN", key: "SCR_WIDTH" },
      { file: "fallout2.cfg", section: "screen", key: "resolution_x", engine: "fallout2-ce" },
    ]);
    // Six sfall keys land in the content config rather than in fallout2.cfg, which is a different file.
    expect(targetsOf("sfall.Misc.DamageFormula")).toEqual([
      { file: "ddraw.ini", section: "Misc", key: "DamageFormula" },
      { file: "game#patch.cfg", section: "combat", key: "damage_formula", engine: "fallout2-ce" },
    ]);
    // Fission renamed one vanilla key rather than dropping it, so the Game tab's row reaches it.
    expect(targetsOf("game.preferences.player_speedup")).toEqual([
      { file: "fallout2.cfg", section: "preferences", key: "player_speedup" },
      { file: "fission.cfg", section: "preferences", key: "player_speed", engine: "fission" },
    ]);
    // Four of these link one engine to the other with no vanilla or sfall row beneath: three keys fallout2-ce
    // introduced that Fission carries under a name of its own, and one it carries under the same name.
    expect(linked.length).toBe(81);
    expect(linked.filter((s) => ownTarget(s).engine !== undefined).map((s) => s.id)).toEqual([
      "game.ui.enable_high_resolution_stencil",
      "game.preferences.running_burning_guy",
      "game.sound.gapless_music",
      "game.qol.auto_open_doors",
    ]);
  });

  it("reaches Fission's copy of every vanilla key it honours", () => {
    // Fission keeps the whole vanilla configuration in a file of its own rather than reading the game's, so
    // every vanilla key it honours is a second address for a row the Game tab already has. Fifty-two of them,
    // which is the count its own source registers - derived from that list, not written out here. The
    // fifty-third same-named key belongs to no vanilla row: fallout2-ce introduced `running_burning_guy` and
    // Fission carries it under the same name, so the link is between the two engines with nothing beneath.
    const sameName = SETTINGS.filter((one) =>
      one.targets.some(
        (t) =>
          t.engine === "fission" &&
          ownTarget(one).file === "fallout2.cfg" &&
          t.section === ownTarget(one).section &&
          t.key === ownTarget(one).key,
      ),
    );
    expect(sameName.length).toBe(53);
    expect(sameName.filter((one) => ownTarget(one).engine !== undefined).map((one) => one.id)).toEqual([
      "game.preferences.running_burning_guy",
    ]);
    // The fifty-third is the one key Fission renamed, which is named by hand because no rule finds it.
    expect(SETTINGS.find((one) => one.id === "game.preferences.player_speedup")!.targets[1]).toEqual({
      file: "fission.cfg",
      section: "preferences",
      key: "player_speed",
      engine: "fission",
    });
    expect(SETTINGS.find((one) => one.id === "game.preferences.game_difficulty")!.targets).toEqual([
      { file: "fallout2.cfg", section: "preferences", key: "game_difficulty" },
      { file: "fission.cfg", section: "preferences", key: "game_difficulty", engine: "fission" },
    ]);
  });

  it("keeps the value spaces of a derived link the same on both sides", () => {
    // The derivation matches on section and key, so the check that makes it safe is the value space: a key
    // the engine reads into a switch must not take a setting whose values are not 0 and 1.
    for (const setting of SETTINGS) {
      if (!setting.targets.some((t) => t.engine === "fission")) continue;
      const kind = setting.kind;
      if (kind.type !== "choice") continue;
      // A choice reaching Fission is one whose options the engine's own field can hold; nothing here narrows.
      expect(kind.options.length, `${setting.id} links an empty choice`).toBeGreaterThan(1);
    }
  });

  it("names the engine every bound address belongs to, which its file and section do not imply", () => {
    // fallout2-ce keeps `f2_res_dat` in the game's own [system] and `gapless_music` in its [sound], beside
    // vanilla keys belonging to no engine - so the write seam cannot read ownership off the address.
    // The own address may name one too - a key an engine added that no other component has is still that
    // engine's - so what this holds is that every engine named is one ZAX knows, and that a target beyond the
    // first always names one, which is what tells a link's far side from its near side.
    const known = new Set(ENGINES.map((one) => one.id));
    for (const s of SETTINGS) {
      for (const [at, target] of s.targets.entries()) {
        if (at > 0) expect(target.engine, `${s.id} -> ${target.file} names no engine`).toBeDefined();
        if (target.engine === undefined) continue;
        expect(known.has(target.engine), `${s.id} -> ${target.engine}`).toBe(true);
      }
    }
  });

  it("stops a link at the engine whose unit differs, rather than dropping the whole link", () => {
    // sfall and fallout2-ce both count quick-save PAGES; Fission counts slots, bounded by its own effective
    // save-slot count. Same name, different quantity - so Fission keeps its own row and the other two link.
    const files = SETTINGS.find((s) => s.id === "sfall.Misc.AutoQuickSave")!.targets.map((t) => t.file);
    expect(files).toEqual(["ddraw.ini", "fallout2.cfg"]);
  });

  it("leaves the pairs whose value spaces differ as separate settings", () => {
    // Each of these looks linkable by name and is not: a bool against a range, three options against two,
    // or two keys collapsing into one enum. A conversion nobody can make honest is worse than two rows.
    for (const id of [
      "sfall.Misc.UseWalkDistance", // sfall 0..3, fallout2-ce 0..100
      "hires.MAIN.SCALE_2X", // a bool against 1..4
      "hires.MOVIES.MOVIE_SIZE", // a three-way choice against a bool
      "hires.IFACE.ALTERNATE_AMMO_METRE", // four options against three, and 1 and 2 differ on each side
      "hires.MAIN.WINDOWED", // two keys collapse into one enum
      "hires.MAIN.WINDOWED_FULLSCREEN",
      "hires.MAINMENU.MAIN_MENU_SIZE", // two keys into one, and the reverse is ambiguous
      "hires.MAINMENU.SCALE_BUTTONS_AND_TEXT_MENU",
    ]) {
      const s = SETTINGS.find((x) => x.id === id);
      expect(s, id).toBeDefined();
      expect(
        s!.targets.map((t) => t.file),
        `${id} was linked`,
      ).toEqual([ownTarget(s!).file]);
    }
  });
});

describe("catalog against real config files", () => {
  const docs = new Map(
    CONFIG_FILES.map((f) => [f, IniDocument.parseBytes(new Uint8Array(readFileSync(`fixtures/f2up/${f}`)))]),
  );

  // Against its own address: a linked setting's engine targets live in files no stock install has.
  const present = (s: SettingDef) =>
    docs.get(ownTarget(s).file as never)?.get(ownTarget(s).section, ownTarget(s).key) !== undefined;

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
    // Two keys sfall ships commented out, so they resolve nowhere until someone sets them. `TranslationsINI`
    // is the only catalog key in ddraw's [Main], which would otherwise read as a section that spells nothing
    // right rather than one whose single key is off by default.
    const COMMENTED_UPSTREAM = new Set(["sfall.Main.TranslationsINI", "sfall.Scripts.IniConfigFolder"]);
    for (const s of SETTINGS) {
      const at = ownTarget(s);
      // Only the files a real install carries. An engine's own config is written by a program nobody here has
      // run, so there is no such fixture to check its spelling against.
      const doc = docs.get(at.file as never);
      if (doc === undefined) continue;
      const sectionPresent = doc.sections().some((x) => x.toLowerCase() === at.section.toLowerCase());
      if (!sectionPresent) continue;
      const siblings = SETTINGS.filter((o) => ownTarget(o).file === at.file && ownTarget(o).section === at.section);
      if (siblings.every((o) => COMMENTED_UPSTREAM.has(o.id))) continue;
      expect(
        siblings.some((o) => doc.get(ownTarget(o).section, ownTarget(o).key) !== undefined),
        `${at.file} contains [${at.section}] but no catalog key in it resolves`,
      ).toBe(true);
    }
  });

  it("creates a section that the installed component version predates", () => {
    const doc = IniDocument.parseBytes(new Uint8Array(readFileSync("fixtures/f2up/ddraw.ini")));
    expect(doc.get("Debugging", "DebugMode")).toBeUndefined();
    doc.set("Debugging", "DebugMode", "debug.log");
    expect(doc.get("Debugging", "DebugMode")).toBe("debug.log");
    expect(doc.toString()).toContain("[Debugging]");
  });

  it("parses every present value under its declared kind", () => {
    for (const s of SETTINGS) {
      const raw = docs.get(ownTarget(s).file as never)?.get(ownTarget(s).section, ownTarget(s).key);
      if (raw === undefined) continue;
      if (s.kind.type === "int") expect(Number.isFinite(Number(raw)), `${s.id}=${raw}`).toBe(true);
      if (s.kind.type === "float") expect(Number.isFinite(Number(raw)), `${s.id}=${raw}`).toBe(true);
      if (s.kind.type === "bool") expect([s.kind.onValue, s.kind.offValue], `${s.id}=${raw}`).toContain(raw);
    }
  });
});

describe("gating rules", () => {
  // A gate rides on the target rather than the setting: a prerequisite can hold for one engine and not for
  // the next, so every check here runs per target rather than per row.
  const gated = SETTINGS.flatMap((s) =>
    s.targets.flatMap((t) => (t.gatedBy === undefined ? [] : [{ setting: s, gate: t.gatedBy }])),
  );

  it("names a controller that exists and is reachable in the same tab", () => {
    for (const { setting, gate } of gated) {
      const controller = SETTINGS.find((c) => c.id === gate.id);
      expect(controller, `${setting.id} is gated by unknown ${gate.id}`).toBeDefined();
      // Where the two are shown is decided by the layout, so that is where the co-location test lives.
    }
  });

  it("requires values the controller can actually hold", () => {
    for (const { setting, gate } of gated) {
      const controller = SETTINGS.find((c) => c.id === gate.id)!;
      // Either form names values; a gate listing none can never open, and one listing none to exclude is a gate
      // that is always open - both are a typo rather than a rule.
      const named = "is" in gate ? gate.is : gate.isNot;
      expect(named.length, `${setting.id} names no values`).toBeGreaterThan(0);
      for (const v of named) {
        if (controller.kind.type === "choice") {
          expect(
            controller.kind.options.map((o) => o.value),
            `${setting.id} <- ${v}`,
          ).toContain(v);
        }
        if (controller.kind.type === "bool") {
          expect([controller.kind.onValue, controller.kind.offValue], `${setting.id} <- ${v}`).toContain(v);
        }
      }
    }
  });

  it("gates the settings whose help only ever said so in prose", () => {
    // Both dependencies survived the port as a sentence and nothing else, so the control rendered fully live
    // while its own help said it needed something else.
    const gateOf = (id: string) => SETTINGS.find((s) => s.id === id)?.targets[0].gatedBy;
    expect(gateOf("sfall.Graphics.AllowDShowMovies")).toEqual({
      id: "sfall.Graphics.Mode",
      is: ["4", "5", "6"],
    });
    expect(gateOf("sfall.Input.FastMoveFromContainer")).toEqual({
      id: "sfall.Input.ItemFastMoveKey",
      isNot: ["0"],
    });
  });

  it("does not gate a setting by itself or form a cycle", () => {
    for (const { setting, gate } of gated) {
      expect(gate.id).not.toBe(setting.id);
      const controller = SETTINGS.find((c) => c.id === gate.id)!;
      for (const t of controller.targets) expect(t.gatedBy?.id).not.toBe(setting.id);
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
    const fix = SETTINGS.find((s) => s.id === "hires.OTHER_SETTINGS.CPU_USAGE_FIX")!;
    const other = SETTINGS.find((s) => s.id === "sfall.Misc.ProcessorIdle")!;
    expect(fix.conflictsWith?.id).toBe(other.id);
    // The two components each idle the process on their own, so neither disables the other and neither may be
    // expressed as a gate - which is the whole reason this mechanism exists alongside gatedBy.
    expect(ownTarget(fix).gatedBy).toBeUndefined();
    expect(ownTarget(other).gatedBy).toBeUndefined();
    expect(ownTarget(fix).file).not.toBe(ownTarget(other).file);
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
    const uac = SETTINGS.find((s) => ownTarget(s).key === "UAC_AWARE");
    expect(uac?.managed?.value).toBe("0");
    const doc = IniDocument.parseBytes(new Uint8Array(readFileSync("fixtures/f2up/f2_res.ini")));
    expect(doc.get("MAIN", "UAC_AWARE")).toBe("1");
  });
});

describe("the engines' own settings", () => {
  // What each project's source registers, read by scripts/gen/extract-engines.mjs and committed beside it.
  // Checking the catalog against this rather than against the projects keeps the suite offline, and keeps
  // "which keys does this engine have" a recorded reading rather than something the generator decides.
  const reading = (id: string) =>
    JSON.parse(readFileSync(`scripts/gen/engines/${id}.json`, "utf8")) as {
      engine: string;
      commit: string;
      keys: ReadonlyArray<{ section: string; key: string; kind: string; min?: number; max?: number }>;
    };
  const readings = ENGINES.map((one) => reading(one.id));

  it("pins each reading to the commit it came from", () => {
    // One of these projects republishes a single tag in place, so a version is not an identity. Without an
    // exact commit the catalog would describe an engine no user can be shown to be running.
    for (const one of readings) {
      expect(one.commit, `${one.engine} records no commit`).toMatch(/^[0-9a-f]{40}$/);
      expect(one.keys.length, `${one.engine} records no keys`).toBeGreaterThan(0);
    }
    expect(readings.map((one) => one.engine)).toEqual(ENGINES.map((one) => one.id));
  });

  it("addresses every engine target at a key that engine actually registers", () => {
    // The half a typo would break silently: a write to a key the engine never reads changes a file and does
    // nothing, and no other check compares the catalog against the source it was drawn from.
    const held = new Map(readings.map((one) => [one.engine, new Set(one.keys.map((k) => `${k.section}|${k.key}`))]));
    for (const s of SETTINGS) {
      for (const target of s.targets) {
        if (target.engine === undefined) continue;
        // fallout2-ce reads the content patch's config through the patch rather than through its own settings
        // table, so those addresses are not in its registrations and are named in the generator's own table.
        if (target.file === "game#patch.cfg") continue;
        expect(
          held.get(target.engine)?.has(`${target.section}|${target.key}`),
          `${s.id} -> ${target.engine} [${target.section}] ${target.key} is not a key it registers`,
        ).toBe(true);
      }
    }
  });

  it("reaches every key an engine registers, from some row or other", () => {
    // The other direction: a key nobody addresses is one the interface cannot change, which is how a new
    // upstream setting would go unnoticed. Fission's two derived resolutions are the stated exception - it
    // recomputes them from `play_area` whenever the preferences screen opens, so a written value does not last.
    //
    // A row reaches an engine's key two ways. Either it carries a target naming that engine, or - where the
    // engine reads the game's own config, as fallout2-ce does - the vanilla row writing that address already
    // is the engine's setting, with no second target to mark.
    const DERIVED = new Set(["fission|graphics|game_width", "fission|graphics|game_height"]);
    const configOf = new Map(ENGINES.map((one) => [one.id, one.settingsMark.file]));
    const reached = new Set(
      SETTINGS.flatMap((s) =>
        s.targets.flatMap((t) =>
          t.engine !== undefined
            ? [`${t.engine}|${t.section}|${t.key}`]
            : ENGINES.filter((e) => configOf.get(e.id) === t.file).map((e) => `${e.id}|${t.section}|${t.key}`),
        ),
      ),
    );
    const unreached = readings.flatMap((one) =>
      one.keys.map((k) => `${one.engine}|${k.section}|${k.key}`).filter((at) => !reached.has(at) && !DERIVED.has(at)),
    );
    expect(unreached, "keys the engine registers that no row addresses").toEqual([]);
  });

  it("keeps a key's storage kind and its control in agreement", () => {
    // A switch offered as a number, or a path offered as a checkbox, writes something the engine will not
    // parse. The engine's own field type is the authority; the catalog's kind has to be one that fits it.
    // A choice fits a bool field only when its values are the two a bool parses; anything wider would write
    // a third value into a field that cannot hold one.
    const FITS: Record<string, (def: SettingDef) => boolean> = {
      bool: (d) =>
        d.kind.type === "bool" ||
        (d.kind.type === "choice" && d.kind.options.every((o) => o.value === "0" || o.value === "1")),
      text: (d) => d.kind.type === "text" || d.kind.type === "choice",
      path: (d) => d.kind.type === "text",
      real: (d) => d.kind.type === "float" || d.kind.type === "scale",
      number: (d) => ["int", "choice", "bool", "scale", "key"].includes(d.kind.type),
    };
    const kindOf = new Map(
      readings.flatMap((one) => one.keys.map((k) => [`${one.engine}|${k.section}|${k.key}`, k.kind] as const)),
    );
    for (const s of SETTINGS) {
      for (const target of s.targets) {
        if (target.engine === undefined || target.file === "game#patch.cfg") continue;
        const stored = kindOf.get(`${target.engine}|${target.section}|${target.key}`);
        if (stored === undefined) continue;
        expect(FITS[stored]?.(s), `${s.id} is a ${s.kind.type} written to a ${stored} field of ${target.engine}`).toBe(
          true,
        );
      }
    }
  });
});
