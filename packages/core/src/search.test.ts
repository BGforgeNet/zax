import { describe, expect, it } from "vitest";
import { searchText, type SettingDef } from "./catalog.js";

const def = (over: Partial<SettingDef>): SettingDef => ({
  id: "x",
  targets: [{ file: "f2_res.ini", section: "MAIN", key: "SCR_WIDTH" }],
  kind: { type: "int" },
  label: "Resolution X",
  ...over,
});

describe("searchText", () => {
  it("carries label, key, section, file and help, lowercased", () => {
    const text = searchText(def({ help: "Sets the horizontal size" }));
    expect(text).toContain("resolution x");
    expect(text).toContain("scr_width");
    expect(text).toContain("main");
    expect(text).toContain("f2_res");
    expect(text).toContain("horizontal");
  });

  it("carries choice option labels", () => {
    const d = def({
      label: "Window mode",
      kind: {
        type: "choice",
        options: [
          { value: "0", label: "Fullscreen" },
          { value: "1", label: "Windowed" },
        ],
      },
    });
    expect(searchText(d)).toContain("fullscreen");
  });

  it("carries nothing beyond those fields", () => {
    // The group label ("High resolution") stays out of SettingDef and out of this text: including it made
    // every setting of that file match a search for "resolution", burying the few settings actually about it.
    const unrelated = def({
      label: "Grayscale",
      targets: [{ file: "f2_res.ini", section: "EFFECTS", key: "IS_GRAY_SCALE" }],
    });
    expect(searchText(unrelated)).not.toContain("resolution");
  });

  it("carries every target's address, so a linked setting is findable by any of its names", () => {
    // A setting several engines carry under different names is one row; searching for the name the engine
    // documents has to reach it, or the link makes the setting harder to find rather than easier.
    const linked = def({
      label: "Expanded barter window",
      targets: [
        { file: "ddraw.ini", section: "Interface", key: "ExpandBarter" },
        { file: "fission.cfg", section: "enhancements", key: "EnhancedBarter" },
      ],
    });
    expect(searchText(linked)).toContain("expandbarter");
    expect(searchText(linked)).toContain("enhancedbarter");
    expect(searchText(linked)).toContain("fission.cfg");
  });
});
