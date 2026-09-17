/**
 * The boundary's two halves, held to each other.
 *
 * `COMMANDS` and the shell's `zax_commands!` list are the one fact written twice - once in Rust, where
 * the compiler checks each name resolves to a command, and once here, where it cannot. This reads the
 * Rust and compares, which is what `backend.test.ts` did for `BACKEND_METHODS` before the port.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { COMMANDS, commands } from "./commands.js";
import { PREVIEW_INSTALL, reseedPreview } from "./preview-fixture.js";

const SHELL = fileURLToPath(new URL("../../../../crates/shell/src/lib.rs", import.meta.url));

/** Every name inside the handler list, which is the shell's whole command surface. */
function registered(): string[] {
  const source = readFileSync(SHELL, "utf8");
  const list = /generate_handler!\[([^\]]*)\]/s.exec(source);
  if (!list) throw new Error("The shell's handler list could not be found - has it been renamed?");
  return [...list[1]!.matchAll(/commands::(\w+)/g)].map((found) => found[1]!);
}

describe("the command surface", () => {
  it("names exactly what the shell registers", () => {
    // As sets: order is not part of either list's meaning, and a repeated name is the next test's to catch.
    expect(new Set(COMMANDS)).toEqual(new Set(registered()));
  });

  it("has a wrapper for every name", () => {
    // The names are snake_case on the wire and camelCase here, so the wrappers are counted rather
    // than matched: a name with no wrapper is a command nothing can call.
    expect(Object.keys(commands)).toHaveLength(COMMANDS.length);
  });

  it("wraps each name once", () => {
    expect(new Set(COMMANDS).size).toBe(COMMANDS.length);
  });
});

/*
  Each wrapper once, against the preview, which dispatches the same names and refuses a field it does not know.
  What is asserted is the wrapper's half of the contract - the name it sends and the keys it spells - so a
  command is free to refuse on its own terms (no network, no program to start) and still pass here. A key
  misspelled in camelCase would otherwise reach Tauri, which drops it, and surface as a missing argument only in
  the desktop build.
*/
describe("each wrapper, sent to the preview", () => {
  beforeEach(reseedPreview);

  const CALLS: Record<keyof typeof commands, () => Promise<unknown>> = {
    start: async () => commands.start("0.0.0"),
    view: async () => commands.view(),
    catalog: async () => commands.catalog(),
    search: async () => commands.search("damage"),
    chooseFolder: async () => commands.chooseFolder("master.dat"),
    selectInstall: async () => commands.selectInstall(PREVIEW_INSTALL),
    refresh: async () => commands.refresh(),
    addInstall: async () => commands.addInstall("fixtures/f2"),
    removeInstall: async () => commands.removeInstall(PREVIEW_INSTALL),
    setAlias: async () => commands.setAlias(PREVIEW_INSTALL, "Mine"),
    setWine: async () => commands.setWine(PREVIEW_INSTALL, { prefix: null, debug: "-all" }),
    setTheme: async () => commands.setTheme("dark"),
    setAutosave: async () => commands.setAutosave(true),
    acceptCaution: async () => commands.acceptCaution("fission"),
    scan: async () => commands.scan(),
    setSettings: async () => commands.setSettings([{ id: "sfall.Misc.UseFileSystemOverride", to: { raw: "1" } }]),
    revertSettings: async () => commands.revertSettings([], true),
    applyAction: async () => commands.applyAction("enable_debug"),
    satisfyGate: async () => commands.satisfyGate("sfall.Misc.UseFileSystemOverride", null),
    chooseLinked: async () => commands.chooseLinked("sfall.Misc.UseFileSystemOverride", "1"),
    editOrder: async () => commands.editOrder({ edit: "sort" }),
    save: async () => commands.save(),
    checkZax: async () => commands.checkZax(),
    checkSfall: async () => commands.checkSfall(),
    checkEngine: async () => commands.checkEngine("fallout2-ce"),
    listSfallVersions: async () => commands.listSfallVersions(),
    changeSfall: async () => commands.changeSfall(null),
    readModListing: async () => commands.readModListing(false),
    planMod: async () => commands.planMod("fo2tweaks", [], {}, "14.7"),
    installMod: async () =>
      commands.installMod({ modId: "fo2tweaks", fingerprint: "", choices: [], answers: {}, version: null }),
    modVersions: async () => commands.modVersions("fo2tweaks", "14.0"),
    restoreMod: async () => commands.restoreMod("fo2tweaks"),
    removeMod: async () => commands.removeMod("fo2tweaks"),
    openModFile: async () => commands.openModFile("fo2tweaks", "mods/fo2tweaks.ini"),
    toggleModPart: async () => commands.toggleModPart([], [], "head", true),
    fetchEngine: async () => commands.fetchEngine("fallout2-ce", null),
    forgetEngine: async () => commands.forgetEngine("fallout2-ce", "2026-07-01T00:00:00Z"),
    useEngineBuild: async () => commands.useEngineBuild("fallout2-ce", { pick: "latest" }),
    orderSwap: async () => commands.orderSwap("fission"),
    launch: async () => commands.launch(null, null),
    listSaves: async () => commands.listSaves(),
    createDebugPackage: async () => commands.createDebugPackage([]),
    open: async () => commands.open({ what: "log" }),
    wipe: async () => commands.wipe({ what: "own", directory: "debug" }),
    cancel: async () => commands.cancel(),
    setBusy: async () => commands.setBusy("Testing"),
  };

  /** The preview's own sentences for a call it could not dispatch, as distinct from one it refused on the merits. */
  const UNDISPATCHED = /^The preview (could not read the arguments|does not answer|was called without)/;

  it("has a call for every wrapper", () => {
    expect(new Set(Object.keys(CALLS))).toEqual(new Set(Object.keys(commands)));
  });

  for (const [name, call] of Object.entries(CALLS)) {
    it(`${name} reaches a command the preview dispatches, with arguments it reads`, async () => {
      const said = await call().then(
        () => "",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(said).not.toMatch(UNDISPATCHED);
    });
  }
});
